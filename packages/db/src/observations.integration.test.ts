import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "./client.js";
import { provisionTestDatabase } from "./testing.js";
import { vaultId as deriveVaultId, vaultSnapshotId } from "./ids.js";
import { migrate } from "./migrate.js";
import {
  CapabilityResolutionError,
  invalidateOrphanedBlock,
  listPromotedBlockHashes,
  promoteRange,
  SchemaVersionError,
  UnknownVaultError,
} from "./repositories/observations.js";
import { readApplicationCursor, writeApplicationCursor } from "./repositories/cursors.js";
import { loadVaultLookup, seedRegistry, type VaultLookup } from "./repositories/vaults.js";
import { bytesToHex, hexToBytes } from "./schema/columns.js";
import {
  evidenceReport,
  reorgInvalidation,
  reportObservation,
  vaultFlow,
  vaultSnapshot,
} from "./schema/observations.js";
import { rawDeposit, rawShareTransfer, rawVaultSnapshot } from "./schema/raw.js";

/**
 * Promotion against a real PostgreSQL instance.
 *
 * Gated on TR4CE_TEST_DATABASE_URL rather than DATABASE_URL: these tests drop and rebuild the
 * schema, which must never happen by accident against a developer's working database, and
 * `pnpm test` has to stay green for anyone without a container running.
 *
 *   docker compose up -d postgres
 *   docker compose exec -T postgres psql -U tr4ce -d postgres -c 'CREATE DATABASE tr4ce_test'
 *   TR4CE_TEST_DATABASE_URL=postgres://tr4ce:tr4ce@localhost:5432/tr4ce_test pnpm --filter @tr4ce/db test
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = 8453;
const SCHEMA_VERSION = "1.0.0";
const STREAM_KEY = "erc4626-promotion-test";
const ACCEPTED = [SCHEMA_VERSION];

/** Window start declared by every curated vault; capability profiles are effective from here. */
const WINDOW_START = Math.min(
  ...baseUsdcVaultManifest.vaults.map((entry) => Number(entry.windowStartBlock)),
);

const [VAULT_A, VAULT_B] = baseUsdcVaultManifest.vaults;
const ADDRESS_A = VAULT_A!.address.toLowerCase();
const ADDRESS_B = VAULT_B!.address.toLowerCase();

const hash = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;
const BLOCK_1 = hash("1");
const BLOCK_2 = hash("2");
const BLOCK_1_REPLACEMENT = hash("9");
const TX_1 = hash("a");
const WALLET = "0x00000000000000000000000000000000000000aa";

describe.skipIf(url === undefined)("promotion and reorg reconciliation", () => {
  let databaseUrl: string;
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;
  let lookup: VaultLookup;

  beforeAll(async () => {
    // Its own database, not a shared one: turbo runs package tasks in parallel, and two suites
    // rebuilding the same schema would tear it down under each other.
    databaseUrl = await provisionTestDatabase(url!, "observations");
    handle = createDatabase(databaseUrl, { max: 2 });
    db = handle.db;

    // The sink's staging tables first, then the application schema, in the order a real deployment
    // creates them. The application half goes through the real migration runner rather than a raw
    // execute, so the runner itself is covered by every test below.
    const sinkSchema = readFileSync(
      join(here, "..", "..", "..", "substreams", "erc4626", "schema.sql"),
      "utf8",
    );

    await db.execute(sql.raw(sinkSchema));

    const applied = await migrate(databaseUrl);

    expect(applied.applied).toEqual(["0001_registry_observations.sql"]);
    // The sink owns `cursors`; the application never creates it, so the test stands in.
    await db.execute(
      sql`CREATE TABLE cursors (id TEXT PRIMARY KEY, cursor TEXT NOT NULL, block_num BIGINT NOT NULL, block_id TEXT NOT NULL)`,
    );

    await db.transaction((tx) =>
      seedRegistry(tx, {
        manifest: baseUsdcVaultManifest,
        network: {
          chainId: CHAIN_ID,
          slug: "base",
          name: "Base",
          nativeSymbol: "ETH",
          confirmationDepth: 64,
        },
        protocols: [
          { slug: "morpho-blue", name: "Morpho", documentationUrl: "https://docs.morpho.org" },
          { slug: "yearn-v3", name: "Yearn V3", documentationUrl: "https://docs.yearn.fi" },
        ],
      }),
    );

    lookup = await loadVaultLookup(db, CHAIN_ID);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    // Truncate rather than re-migrate: the schema is the thing under test and rebuilding it per
    // test would hide a constraint that only bites on the second insert.
    await db.execute(
      sql`TRUNCATE report_observation, evidence_report, reorg_invalidation, vault_flow, vault_snapshot, indexer_cursor,
                   raw_erc4626_deposit, raw_erc4626_withdraw, raw_erc4626_share_transfer, raw_erc4626_vault_snapshot`,
    );
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  const blockTime = (blockNumber: number) => new Date(1_756_000_000_000 + blockNumber * 2000);

  async function insertRawDeposit(overrides: {
    blockNumber: number;
    blockHash: string;
    vault?: string;
    logIndex?: number;
    schemaVersion?: string;
  }): Promise<void> {
    await db.insert(rawDeposit).values({
      chainId: CHAIN_ID,
      blockHash: overrides.blockHash,
      transactionHash: TX_1,
      logIndex: overrides.logIndex ?? 0,
      blockNumber: overrides.blockNumber,
      blockTime: blockTime(overrides.blockNumber),
      vault: overrides.vault ?? ADDRESS_A,
      sender: WALLET,
      owner: WALLET,
      assets: "1000000",
      shares: "990000000000000000",
      schemaVersion: overrides.schemaVersion ?? SCHEMA_VERSION,
    });
  }

  async function insertRawSnapshot(overrides: {
    blockNumber: number;
    blockHash: string;
    vault?: string;
    callStatus?: string;
    callErrors?: string;
    totalAssets?: string | null;
    schemaVersion?: string;
  }): Promise<void> {
    await db.insert(rawVaultSnapshot).values({
      chainId: CHAIN_ID,
      vault: overrides.vault ?? ADDRESS_A,
      blockHash: overrides.blockHash,
      schemaVersion: overrides.schemaVersion ?? SCHEMA_VERSION,
      blockNumber: overrides.blockNumber,
      blockTime: blockTime(overrides.blockNumber),
      asset: baseUsdcVaultManifest.canonicalAssets[0]!.address.toLowerCase(),
      shareDecimals: 18,
      assetDecimals: 6,
      totalAssets: overrides.totalAssets === undefined ? "417000000000" : overrides.totalAssets,
      totalSupply: "1000000000000000000000",
      oneShareUnits: "1000000000000000000",
      oneShareAssets: "1109000",
      callStatus: overrides.callStatus ?? "ok",
      callErrors: overrides.callErrors ?? "[]",
      triggerActivity: false,
      triggerCheckpoint: false,
      triggerAnchor: true,
    });
  }

  const promote = (fromBlock: number, toBlock: number) =>
    db.transaction((tx) =>
      promoteRange(tx, {
        chainId: CHAIN_ID,
        fromBlock,
        toBlock,
        lookup,
        acceptedSchemaVersions: ACCEPTED,
      }),
    );

  /** Every application column that promotion is responsible for, ordered deterministically. */
  async function snapshotOfApplicationTables(): Promise<string> {
    const rows = await db.execute<{ digest: string }>(sql`
      SELECT md5(string_agg(row, '|' ORDER BY row)) AS digest FROM (
        SELECT concat_ws(':', 'flow', id, vault_id, chain_id, block_number,
                         encode(block_hash, 'hex'), encode(transaction_hash, 'hex'), log_index,
                         kind, transfer_kind, encode(sender, 'hex'), encode(owner, 'hex'),
                         encode(receiver, 'hex'), assets, shares, canonical, schema_version,
                         promoted_at) AS row
          FROM vault_flow
        UNION ALL
        SELECT concat_ws(':', 'snapshot', id, vault_id, capability_id, chain_id, block_number,
                         encode(block_hash, 'hex'), total_assets, total_supply, one_share_units,
                         one_share_assets, call_status, call_errors::text, canonical,
                         schema_version, observed_at) AS row
          FROM vault_snapshot
      ) rows
    `);

    return rows[0]?.digest ?? "empty";
  }

  // -------------------------------------------------------------------------------------------
  // Replay idempotency (checklist item 2)
  // -------------------------------------------------------------------------------------------

  describe("replay", () => {
    it("produces byte-identical application rows, primary keys included", async () => {
      await insertRawDeposit({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });
      await insertRawSnapshot({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });

      const first = await promote(WINDOW_START, WINDOW_START + 100);
      const afterFirst = await snapshotOfApplicationTables();

      const second = await promote(WINDOW_START, WINDOW_START + 100);
      const afterSecond = await snapshotOfApplicationTables();

      expect(first).toEqual(second);
      // Includes promoted_at and observed_at: a replay that rewrote "when we first saw this" would
      // quietly destroy the provenance an evidence report depends on.
      expect(afterSecond).toBe(afterFirst);
    });

    it("does not duplicate rows when overlapping ranges are replayed", async () => {
      await insertRawDeposit({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });
      await insertRawDeposit({
        blockNumber: WINDOW_START + 20,
        blockHash: BLOCK_2,
        logIndex: 1,
      });

      await promote(WINDOW_START, WINDOW_START + 15);
      await promote(WINDOW_START, WINDOW_START + 100);
      await promote(WINDOW_START + 5, WINDOW_START + 25);

      const rows = await db.select().from(vaultFlow);

      expect(rows).toHaveLength(2);
    });

    it("keeps one row per log position when a transaction emits several events", async () => {
      // The canonical key is (chain, block hash, transaction hash, log index, kind). Deduplicating
      // on transaction hash alone would collapse a deposit and its share mint into one row.
      await insertRawDeposit({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1, logIndex: 4 });
      await db.insert(rawShareTransfer).values({
        chainId: CHAIN_ID,
        blockHash: BLOCK_1,
        transactionHash: TX_1,
        logIndex: 5,
        blockNumber: WINDOW_START + 10,
        blockTime: blockTime(WINDOW_START + 10),
        vault: ADDRESS_A,
        fromAddress: "0x0000000000000000000000000000000000000000",
        toAddress: WALLET,
        shares: "990000000000000000",
        transferKind: "mint",
        schemaVersion: SCHEMA_VERSION,
      });

      await promote(WINDOW_START, WINDOW_START + 100);

      const rows = await db.select().from(vaultFlow);

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.kind).sort()).toEqual(["deposit", "share_transfer"]);
      // A mint is recorded and classified, not dropped, so the evidence engine can prove it
      // excluded it from economic flow rather than never having seen it.
      expect(rows.find((row) => row.kind === "share_transfer")?.transferKind).toBe("mint");
      expect(rows.find((row) => row.kind === "share_transfer")?.assets).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // The promotion bound (checklist item 3)
  // -------------------------------------------------------------------------------------------

  describe("the confirmed-head bound", () => {
    /**
     * A Base reorg cannot be summoned on demand, and the undo itself is the sink's code, not ours.
     * What is ours and fully testable is the bound: promotion never reads above the confirmed
     * head, so anything the sink is still entitled to undo has never reached the application
     * tables. That is the property the acceptance clause actually rests on.
     */
    it("never promotes a row above the ceiling, so a sink undo can never orphan a promoted row", async () => {
      const confirmed = WINDOW_START + 50;

      await insertRawDeposit({ blockNumber: confirmed - 10, blockHash: BLOCK_1 });
      await insertRawDeposit({ blockNumber: confirmed + 10, blockHash: BLOCK_2, logIndex: 1 });

      await promote(WINDOW_START, confirmed);

      const rows = await db.select().from(vaultFlow);

      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.blockNumber)).toBe(confirmed - 10);

      // The sink now undoes the unconfirmed block, exactly as it would during a pre-confirmation
      // reorg. Nothing in the application schema is affected, because nothing from it was there.
      await db.execute(sql`DELETE FROM raw_erc4626_deposit WHERE block_hash = ${BLOCK_2}`);

      await promote(WINDOW_START, confirmed);

      expect(await db.select().from(vaultFlow)).toHaveLength(1);
    });

    it("promotes the replacement block once it clears the ceiling", async () => {
      // The other half: a reorged block that the sink replaced before confirmation is promoted in
      // its corrected form, and the orphan never appears at all.
      await insertRawDeposit({ blockNumber: WINDOW_START + 60, blockHash: BLOCK_1_REPLACEMENT });

      await promote(WINDOW_START, WINDOW_START + 100);

      const rows = await db.select().from(vaultFlow);

      expect(rows).toHaveLength(1);
      expect(bytesToHex(rows[0]!.blockHash)).toBe(BLOCK_1_REPLACEMENT);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Failed reads stay failed (checklist item 5)
  // -------------------------------------------------------------------------------------------

  describe("failed reads", () => {
    it("promotes a reverted snapshot and stores the missing value as NULL, not zero", async () => {
      await insertRawSnapshot({
        blockNumber: WINDOW_START + 10,
        blockHash: BLOCK_1,
        callStatus: "reverted",
        callErrors: '[{"method":"totalAssets","classification":"reverted"}]',
        totalAssets: null,
      });

      await promote(WINDOW_START, WINDOW_START + 100);

      const [row] = await db.select().from(vaultSnapshot);

      // Dropping the row would make missing evidence invisible; a zero would read as a vault that
      // lost every deposit. Both are worse than an explicit unknown.
      expect(row).toBeDefined();
      expect(row!.callStatus).toBe("reverted");
      expect(row!.totalAssets).toBeNull();
      expect(row!.callErrors).toEqual([{ method: "totalAssets", classification: "reverted" }]);
    });

    it("still snapshots the other vaults in a block where one vault reverted", async () => {
      await insertRawSnapshot({
        blockNumber: WINDOW_START + 10,
        blockHash: BLOCK_1,
        vault: ADDRESS_A,
        callStatus: "reverted",
        callErrors: '[{"method":"totalAssets","classification":"reverted"}]',
        totalAssets: null,
      });
      await insertRawSnapshot({
        blockNumber: WINDOW_START + 10,
        blockHash: BLOCK_1,
        vault: ADDRESS_B,
      });

      await promote(WINDOW_START, WINDOW_START + 100);

      const rows = await db.select().from(vaultSnapshot);

      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.callStatus === "ok")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Rejected batches preserve the cursor (checklist item 6)
  // -------------------------------------------------------------------------------------------

  describe("rejected batches", () => {
    async function cursorBefore(): Promise<void> {
      await writeApplicationCursor(db, {
        chainId: CHAIN_ID,
        streamKey: STREAM_KEY,
        blockNumber: WINDOW_START,
        blockHash: BLOCK_1,
        schemaVersion: SCHEMA_VERSION,
      });
    }

    async function expectCursorUnmoved(): Promise<void> {
      const cursor = await readApplicationCursor(db, CHAIN_ID, STREAM_KEY);

      expect(cursor?.blockNumber).toBe(WINDOW_START);
      expect(cursor?.blockHash).toBe(BLOCK_1);
    }

    it("rejects an unknown producer schema version and promotes nothing", async () => {
      await cursorBefore();
      await insertRawDeposit({
        blockNumber: WINDOW_START + 10,
        blockHash: BLOCK_1,
        schemaVersion: "2.0.0",
      });

      await expect(promote(WINDOW_START, WINDOW_START + 100)).rejects.toThrow(SchemaVersionError);

      expect(await db.select().from(vaultFlow)).toHaveLength(0);
      await expectCursorUnmoved();
    });

    it("rejects a row naming an unregistered vault", async () => {
      await cursorBefore();
      await insertRawDeposit({
        blockNumber: WINDOW_START + 10,
        blockHash: BLOCK_1,
        vault: "0x000000000000000000000000000000000000dead",
      });

      await expect(promote(WINDOW_START, WINDOW_START + 100)).rejects.toThrow(UnknownVaultError);

      expect(await db.select().from(vaultFlow)).toHaveLength(0);
      await expectCursorUnmoved();
    });

    it("rejects a snapshot no capability profile covers", async () => {
      await cursorBefore();
      // Before the window start, so no profile is in force. A snapshot whose reads cannot be
      // interpreted is not evidence, and storing it with a null profile would let a later report
      // read it as though it were.
      await insertRawSnapshot({ blockNumber: WINDOW_START - 5, blockHash: BLOCK_1 });

      await expect(promote(WINDOW_START - 100, WINDOW_START + 100)).rejects.toThrow(
        CapabilityResolutionError,
      );

      expect(await db.select().from(vaultSnapshot)).toHaveLength(0);
      await expectCursorUnmoved();
    });

    it("rolls back rows that had already been written earlier in the same batch", async () => {
      await cursorBefore();
      await insertRawDeposit({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });
      await insertRawSnapshot({ blockNumber: WINDOW_START - 5, blockHash: BLOCK_2 });

      await expect(promote(WINDOW_START - 100, WINDOW_START + 100)).rejects.toThrow();

      // Partial promotion is the failure this guards: a committed deposit with no accompanying
      // snapshot would look like a flow into a vault whose value was never observed.
      expect(await db.select().from(vaultFlow)).toHaveLength(0);
      await expectCursorUnmoved();
    });
  });

  // -------------------------------------------------------------------------------------------
  // Deep reorg (checklist item 4)
  // -------------------------------------------------------------------------------------------

  describe("deep reorg", () => {
    /**
     * Synthesised, because a Base reorg deeper than the confirmation depth cannot be produced on
     * demand. What is real here is everything after detection: the same repository code path runs,
     * against the same constraints, on rows promoted by the same promotion code.
     */
    async function promoteAndCite(): Promise<{ reportId: string; snapshotRowId: string }> {
      await insertRawDeposit({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });
      await insertRawSnapshot({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });
      await promote(WINDOW_START, WINDOW_START + 100);

      const vaultRowId = deriveVaultId(CHAIN_ID, ADDRESS_A);
      const snapshotRowId = vaultSnapshotId(CHAIN_ID, ADDRESS_A, BLOCK_1, SCHEMA_VERSION);
      const reportId = "11111111-1111-5111-8111-111111111111";

      await db.insert(evidenceReport).values({
        id: reportId,
        vaultId: vaultRowId,
        chainId: CHAIN_ID,
        asOfBlockNumber: String(WINDOW_START + 10),
        asOfBlockHash: hexToBytes(BLOCK_1),
        schemaVersion: SCHEMA_VERSION,
        calculationVersion: "1.0.0",
      });

      await db.insert(reportObservation).values({
        id: "22222222-2222-5222-8222-222222222222",
        reportId,
        vaultId: vaultRowId,
        vaultSnapshotId: snapshotRowId,
        role: "as_of",
      });

      return { reportId, snapshotRowId };
    }

    it("marks orphaned observations non-canonical without deleting anything", async () => {
      await promoteAndCite();

      const before = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM vault_snapshot`,
      );

      await db.transaction((tx) =>
        invalidateOrphanedBlock(tx, CHAIN_ID, {
          blockNumber: WINDOW_START + 10,
          orphanedBlockHash: BLOCK_1,
          canonicalBlockHash: BLOCK_1_REPLACEMENT,
        }),
      );

      const after = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM vault_snapshot`,
      );

      // Invalidation is append/audit state, not destructive deletion (ERD section 11).
      expect(after[0]!.count).toBe(before[0]!.count);
      expect((await db.select().from(vaultSnapshot))[0]!.canonical).toBe(false);
      expect((await db.select().from(vaultFlow))[0]!.canonical).toBe(false);
    });

    it("invalidates every report resting on an orphaned observation", async () => {
      const { reportId } = await promoteAndCite();

      const result = await db.transaction((tx) =>
        invalidateOrphanedBlock(tx, CHAIN_ID, {
          blockNumber: WINDOW_START + 10,
          orphanedBlockHash: BLOCK_1,
          canonicalBlockHash: BLOCK_1_REPLACEMENT,
        }),
      );

      expect(result).toEqual({ flows: 1, snapshots: 1, reports: 1 });

      const [report] = await db
        .select()
        .from(evidenceReport)
        .where(eq(evidenceReport.id, reportId));

      expect(report!.canonical).toBe(false);
      expect(report!.invalidationReason).toBe("REORG_INVALIDATED");
      expect(report!.invalidatedAt).not.toBeNull();
    });

    it("records one audit row per invalidated subject", async () => {
      await promoteAndCite();

      await db.transaction((tx) =>
        invalidateOrphanedBlock(tx, CHAIN_ID, {
          blockNumber: WINDOW_START + 10,
          orphanedBlockHash: BLOCK_1,
          canonicalBlockHash: BLOCK_1_REPLACEMENT,
        }),
      );

      const audit = await db.select().from(reorgInvalidation);

      expect(audit).toHaveLength(3);
      expect(audit.map((row) => row.subjectKind).sort()).toEqual([
        "evidence_report",
        "vault_flow",
        "vault_snapshot",
      ]);
      // The audit row carries both hashes, so the record says what was believed and what replaced
      // it, not merely that something changed.
      expect(bytesToHex(audit[0]!.orphanedBlockHash)).toBe(BLOCK_1);
      expect(bytesToHex(audit[0]!.canonicalBlockHash)).toBe(BLOCK_1_REPLACEMENT);
    });

    it("is idempotent when reconciliation runs twice over the same orphan", async () => {
      await promoteAndCite();

      const orphan = {
        blockNumber: WINDOW_START + 10,
        orphanedBlockHash: BLOCK_1,
        canonicalBlockHash: BLOCK_1_REPLACEMENT,
      };

      await db.transaction((tx) => invalidateOrphanedBlock(tx, CHAIN_ID, orphan));
      const second = await db.transaction((tx) => invalidateOrphanedBlock(tx, CHAIN_ID, orphan));

      // Nothing is still canonical to invalidate, and no audit row is duplicated.
      expect(second).toEqual({ flows: 0, snapshots: 0, reports: 0 });
      expect(await db.select().from(reorgInvalidation)).toHaveLength(3);
    });

    it("leaves observations from other blocks alone", async () => {
      await promoteAndCite();
      await insertRawSnapshot({ blockNumber: WINDOW_START + 20, blockHash: BLOCK_2 });
      await promote(WINDOW_START, WINDOW_START + 100);

      await db.transaction((tx) =>
        invalidateOrphanedBlock(tx, CHAIN_ID, {
          blockNumber: WINDOW_START + 10,
          orphanedBlockHash: BLOCK_1,
          canonicalBlockHash: BLOCK_1_REPLACEMENT,
        }),
      );

      const survivors = await db
        .select()
        .from(vaultSnapshot)
        .where(eq(vaultSnapshot.canonical, true));

      expect(survivors).toHaveLength(1);
      expect(bytesToHex(survivors[0]!.blockHash)).toBe(BLOCK_2);
    });

    it("does not resurrect an invalidated row when the same range is promoted again", async () => {
      await promoteAndCite();

      await db.transaction((tx) =>
        invalidateOrphanedBlock(tx, CHAIN_ID, {
          blockNumber: WINDOW_START + 10,
          orphanedBlockHash: BLOCK_1,
          canonicalBlockHash: BLOCK_1_REPLACEMENT,
        }),
      );

      // The raw rows for the orphaned block are still present here — a harsher case than reality,
      // where the sink would have removed them. Promotion must still not flip canonical back.
      await promote(WINDOW_START, WINDOW_START + 100);

      expect((await db.select().from(vaultSnapshot))[0]!.canonical).toBe(false);
      expect((await db.select().from(vaultFlow))[0]!.canonical).toBe(false);
    });

    it("reports the promoted block hashes reconciliation has to verify", async () => {
      await promoteAndCite();

      const promoted = await listPromotedBlockHashes(db, CHAIN_ID, WINDOW_START);

      expect(promoted).toEqual([{ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 }]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Constraints the database enforces on its own (ERD section 11)
  // -------------------------------------------------------------------------------------------

  describe("database-enforced integrity", () => {
    it("refuses a report citing a non-canonical observation at creation time", async () => {
      await insertRawSnapshot({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });
      await promote(WINDOW_START, WINDOW_START + 100);

      const vaultRowId = deriveVaultId(CHAIN_ID, ADDRESS_A);
      const snapshotRowId = vaultSnapshotId(CHAIN_ID, ADDRESS_A, BLOCK_1, SCHEMA_VERSION);

      await db
        .update(vaultSnapshot)
        .set({ canonical: false })
        .where(eq(vaultSnapshot.id, snapshotRowId));

      await db.insert(evidenceReport).values({
        id: "33333333-3333-5333-8333-333333333333",
        vaultId: vaultRowId,
        chainId: CHAIN_ID,
        asOfBlockNumber: String(WINDOW_START + 10),
        asOfBlockHash: hexToBytes(BLOCK_1),
        schemaVersion: SCHEMA_VERSION,
        calculationVersion: "1.0.0",
      });

      const failure = await db
        .insert(reportObservation)
        .values({
          id: "44444444-4444-5444-8444-444444444444",
          reportId: "33333333-3333-5333-8333-333333333333",
          vaultId: vaultRowId,
          vaultSnapshotId: snapshotRowId,
          role: "as_of",
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      // Drizzle wraps the driver error, so the trigger's own message lives on the cause.
      expect(failure).not.toBeNull();
      expect(String((failure as { cause?: { message?: string } }).cause?.message)).toMatch(
        /non-canonical/,
      );
    });

    it("refuses a report on one vault citing another vault's observation", async () => {
      await insertRawSnapshot({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1, vault: ADDRESS_B });
      await promote(WINDOW_START, WINDOW_START + 100);

      const vaultA = deriveVaultId(CHAIN_ID, ADDRESS_A);
      const snapshotOfB = vaultSnapshotId(CHAIN_ID, ADDRESS_B, BLOCK_1, SCHEMA_VERSION);

      await db.insert(evidenceReport).values({
        id: "55555555-5555-5555-8555-555555555555",
        vaultId: vaultA,
        chainId: CHAIN_ID,
        asOfBlockNumber: String(WINDOW_START + 10),
        asOfBlockHash: hexToBytes(BLOCK_1),
        schemaVersion: SCHEMA_VERSION,
        calculationVersion: "1.0.0",
      });

      // The composite foreign key catches this in the database, so an application bug cannot mix
      // two vaults' evidence into one report no matter how the calculation is written.
      await expect(
        db.insert(reportObservation).values({
          id: "66666666-6666-5666-8666-666666666666",
          reportId: "55555555-5555-5555-8555-555555555555",
          vaultId: vaultA,
          vaultSnapshotId: snapshotOfB,
          role: "as_of",
        }),
      ).rejects.toThrow();
    });

    it("refuses a snapshot claiming a capability profile from another vault", async () => {
      const capabilityOfB = (await loadVaultLookup(db, CHAIN_ID)).get(ADDRESS_B)!.capabilities[0]!;

      await expect(
        db.insert(vaultSnapshot).values({
          id: "77777777-7777-5777-8777-777777777777",
          vaultId: deriveVaultId(CHAIN_ID, ADDRESS_A),
          capabilityId: capabilityOfB.id,
          chainId: CHAIN_ID,
          blockNumber: String(WINDOW_START + 10),
          blockHash: hexToBytes(BLOCK_1),
          blockTime: blockTime(WINDOW_START + 10),
          totalAssets: "1",
          totalSupply: "1",
          oneShareUnits: "1000000000000000000",
          oneShareAssets: "1",
          callStatus: "ok",
          callErrors: [],
          triggerActivity: false,
          triggerCheckpoint: false,
          triggerAnchor: true,
          schemaVersion: SCHEMA_VERSION,
        }),
      ).rejects.toThrow();
    });

    it("refuses a snapshot no trigger explains", async () => {
      const capabilityOfA = (await loadVaultLookup(db, CHAIN_ID)).get(ADDRESS_A)!.capabilities[0]!;

      await expect(
        db.insert(vaultSnapshot).values({
          id: "88888888-8888-5888-8888-888888888888",
          vaultId: deriveVaultId(CHAIN_ID, ADDRESS_A),
          capabilityId: capabilityOfA.id,
          chainId: CHAIN_ID,
          blockNumber: String(WINDOW_START + 10),
          blockHash: hexToBytes(BLOCK_1),
          blockTime: blockTime(WINDOW_START + 10),
          totalAssets: "1",
          totalSupply: "1",
          oneShareUnits: "1000000000000000000",
          oneShareAssets: "1",
          callStatus: "ok",
          callErrors: [],
          triggerActivity: false,
          triggerCheckpoint: false,
          triggerAnchor: false,
          schemaVersion: SCHEMA_VERSION,
        }),
      ).rejects.toThrow();
    });

    it("refuses an ok snapshot that carries call errors", async () => {
      await insertRawSnapshot({
        blockNumber: WINDOW_START + 10,
        blockHash: BLOCK_1,
        callStatus: "ok",
        callErrors: '[{"method":"totalAssets","classification":"reverted"}]',
      });

      // Contradictory evidence must not be storable: a status of "ok" beside a recorded failure
      // would let a rule pass on a read that did not happen.
      await expect(promote(WINDOW_START, WINDOW_START + 100)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------------------------
  // Cursor semantics
  // -------------------------------------------------------------------------------------------

  describe("promotion cursor", () => {
    it("records the highest block actually attested to, with its hash", async () => {
      await insertRawDeposit({ blockNumber: WINDOW_START + 10, blockHash: BLOCK_1 });
      await insertRawSnapshot({ blockNumber: WINDOW_START + 20, blockHash: BLOCK_2 });

      const result = await promote(WINDOW_START, WINDOW_START + 100);

      expect(result.attested).toEqual({
        blockNumber: WINDOW_START + 20,
        blockHash: BLOCK_2,
        schemaVersion: SCHEMA_VERSION,
      });
    });

    it("attests to nothing for an empty range", async () => {
      const result = await promote(WINDOW_START, WINDOW_START + 100);

      // The cursor tracks the last block observed, so an empty range leaves it where it is rather
      // than claiming a hash for a block nothing was seen at.
      expect(result.attested).toBeNull();
    });
  });
});
