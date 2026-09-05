import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  hexToBytes,
  indexerCursor,
  migrate,
  rawVaultSnapshot,
  provisionTestDatabase,
  readApplicationCursor,
  seedRegistry,
  vaultFlow,
  vaultSnapshot,
  type Database,
} from "@tr4ce/db";
import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BASE_NETWORK, PROTOCOL_SEEDS, STREAM_KEY } from "./config.js";
import { promoteConfirmed } from "./promote-confirmed.js";
import { reconcileDeepReorg } from "./reconcile-deep-reorg.js";

/**
 * The two orchestration functions, against a real database.
 *
 * `packages/db` covers `promoteRange` and `invalidateOrphanedBlock`. What is only covered here is
 * what sits above them: how far the cursor moves and what hash it records. Both of the defects
 * found during Task 3's live verification lived in exactly this layer and would have survived the
 * entire db suite —
 *
 *   1. the cursor only advanced on blocks that produced a row, so a cold start over the sparse
 *      indexed set re-scanned the same empty range forever and never reached the data;
 *   2. a rewind reused the previous cursor's hash, attaching the hash of one block to a different
 *      block number.
 *
 * Chain reads are stubbed rather than live, so each assertion is about the code under test and not
 * about what Base happened to look like when it ran.
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = BASE_NETWORK.chainId;
const SCHEMA_VERSION = "1.0.0";
const WINDOW_START = Math.min(
  ...baseUsdcVaultManifest.vaults.map((entry) => Number(entry.windowStartBlock)),
);
const VAULT = baseUsdcVaultManifest.vaults[0]!.address.toLowerCase();

/** A distinct, deterministic hash per block, so a wrong block number produces a wrong hash. */
const chainHashAt = (blockNumber: number) => `0x${blockNumber.toString(16).padStart(64, "0")}`;

describe.skipIf(url === undefined)("worker orchestration", () => {
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;

  beforeAll(async () => {
    // Its own database; see the note in @tr4ce/db's suite.
    const databaseUrl = await provisionTestDatabase(url!, "worker");

    handle = createDatabase(databaseUrl, { max: 2 });
    db = handle.db;

    const sinkSchema = readFileSync(
      join(here, "..", "..", "..", "substreams", "erc4626", "schema.sql"),
      "utf8",
    );

    await db.execute(sql.raw(sinkSchema));
    await migrate(databaseUrl);
    await db.execute(
      sql`CREATE TABLE cursors (id TEXT PRIMARY KEY, cursor TEXT NOT NULL, block_num BIGINT NOT NULL, block_id TEXT NOT NULL)`,
    );

    await db.transaction((tx) =>
      seedRegistry(tx, {
        manifest: baseUsdcVaultManifest,
        network: BASE_NETWORK,
        protocols: PROTOCOL_SEEDS,
      }),
    );
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE report_observation, evidence_report, reorg_invalidation, vault_flow, vault_snapshot,
                   indexer_cursor, raw_erc4626_vault_snapshot, cursors`,
    );
  });

  /** Tell the worker how far the sink has written. */
  async function setSinkHead(blockNumber: number): Promise<void> {
    await db.execute(sql`
      INSERT INTO cursors (id, cursor, block_num, block_id)
      VALUES ('test', 'opaque', ${blockNumber}, ${chainHashAt(blockNumber).slice(2)})
    `);
  }

  async function insertRawSnapshot(blockNumber: number): Promise<void> {
    await db.insert(rawVaultSnapshot).values({
      chainId: CHAIN_ID,
      vault: VAULT,
      blockHash: chainHashAt(blockNumber),
      schemaVersion: SCHEMA_VERSION,
      blockNumber,
      blockTime: new Date(1_756_000_000_000 + blockNumber * 2000),
      asset: baseUsdcVaultManifest.canonicalAssets[0]!.address.toLowerCase(),
      shareDecimals: 18,
      assetDecimals: 6,
      totalAssets: "417000000000",
      totalSupply: "1000000000000000000000",
      oneShareUnits: "1000000000000000000",
      oneShareAssets: "1109000",
      callStatus: "ok",
      callErrors: "[]",
      triggerActivity: false,
      triggerCheckpoint: false,
      triggerAnchor: true,
    });
  }

  const promote = (rpcHead: number) =>
    promoteConfirmed({
      db,
      chainId: CHAIN_ID,
      rpcHead,
      canonicalHashAt: (blockNumber) => Promise.resolve(chainHashAt(blockNumber)),
      // Bounded so the "consecutive runs make progress" case needs more than one pass.
      maxBlocksPerRun: 10_000,
    });

  describe("promotion cursor", () => {
    it("advances past a range that contained no observations", async () => {
      // The regression that stalled the cold start. The indexed set is sparse — a checkpoint every
      // 1800 blocks, activity only where a vault was touched — so a cursor that moved only on
      // observed blocks sat on the first empty batch and never reached the data behind it.
      const ceiling = WINDOW_START + 500;

      await setSinkHead(ceiling);

      const outcome = await promote(ceiling + 64);

      expect(outcome.promoted).toEqual({
        deposits: 0,
        withdrawals: 0,
        shareTransfers: 0,
        snapshots: 0,
        attested: null,
      });
      expect(outcome.cursorAdvancedTo).toBe(ceiling);

      const cursor = await readApplicationCursor(db, CHAIN_ID, STREAM_KEY);

      expect(cursor?.blockNumber).toBe(ceiling);
    });

    it("makes progress across consecutive runs over an empty range", async () => {
      const ceiling = WINDOW_START + 25_000;

      await setSinkHead(ceiling);

      const first = await promote(ceiling + 64);
      const second = await promote(ceiling + 64);

      expect(second.cursorAdvancedTo).toBeGreaterThan(first.cursorAdvancedTo!);
    });

    it("records the chain's hash for the block it stopped at", async () => {
      const ceiling = WINDOW_START + 500;

      await setSinkHead(ceiling);
      await promote(ceiling + 64);

      const cursor = await readApplicationCursor(db, CHAIN_ID, STREAM_KEY);

      // Not the hash of the last observed block, and not a hash carried over: the hash of exactly
      // the block the cursor names.
      expect(cursor?.blockHash).toBe(chainHashAt(ceiling));
    });

    it("stops at the sink head even when the confirmed head is higher", async () => {
      await setSinkHead(WINDOW_START + 100);

      const outcome = await promote(WINDOW_START + 50_000);

      expect(outcome.cursorAdvancedTo).toBe(WINDOW_START + 100);
    });

    it("promotes nothing before the sink has written anything", async () => {
      const outcome = await promote(WINDOW_START + 50_000);

      expect(outcome.range).toBeNull();
      expect(await readApplicationCursor(db, CHAIN_ID, STREAM_KEY)).toBeNull();
    });

    it("refuses to advance when the provider cannot answer for the range end", async () => {
      await setSinkHead(WINDOW_START + 500);

      // Advancing here would record a claim about a block the worker never saw.
      await expect(
        promoteConfirmed({
          db,
          chainId: CHAIN_ID,
          rpcHead: WINDOW_START + 600,
          canonicalHashAt: () => Promise.resolve(null),
        }),
      ).rejects.toThrow(/no block at/);

      expect(await readApplicationCursor(db, CHAIN_ID, STREAM_KEY)).toBeNull();
    });
  });

  describe("deep-reorg rewind", () => {
    const ORPHAN_BLOCK = WINDOW_START + 200;

    async function promoteThenOrphan(): Promise<void> {
      await setSinkHead(WINDOW_START + 500);
      await insertRawSnapshot(ORPHAN_BLOCK);
      await insertRawSnapshot(WINDOW_START + 400);
      await promote(WINDOW_START + 600);

      // Rewrite the promoted hash so the chain and the database disagree at one block, which is
      // what a reorg deeper than the confirmation depth looks like after the fact.
      await db
        .update(vaultSnapshot)
        .set({ blockHash: hexToBytes(`0x${"ee".repeat(32)}`) })
        .where(eq(vaultSnapshot.blockNumber, String(ORPHAN_BLOCK)));
    }

    it("anchors the rewound cursor on the chain's hash for the anchor block", async () => {
      await promoteThenOrphan();

      const before = await readApplicationCursor(db, CHAIN_ID, STREAM_KEY);

      const outcome = await reconcileDeepReorg({
        db,
        chainId: CHAIN_ID,
        canonicalHashAt: (blockNumber) => Promise.resolve(chainHashAt(blockNumber)),
      });

      expect(outcome.orphaned).toHaveLength(1);
      expect(outcome.rewoundTo).toBe(ORPHAN_BLOCK - 1);

      const after = await readApplicationCursor(db, CHAIN_ID, STREAM_KEY);

      // The defect this pins down: the rewind used to keep the previous cursor's hash, which
      // belongs to a completely different block. A cursor's hash is a claim about the block it
      // names, and a later reconciliation reads it as one.
      expect(after?.blockHash).toBe(chainHashAt(ORPHAN_BLOCK - 1));
      expect(after?.blockHash).not.toBe(before?.blockHash);
      expect(after?.blockNumber).toBe(ORPHAN_BLOCK - 1);
    });

    it("marks the orphaned observation non-canonical and leaves the others alone", async () => {
      await promoteThenOrphan();

      await reconcileDeepReorg({
        db,
        chainId: CHAIN_ID,
        canonicalHashAt: (blockNumber) => Promise.resolve(chainHashAt(blockNumber)),
      });

      const rows = await db.select().from(vaultSnapshot);

      expect(rows.filter((row) => row.canonical)).toHaveLength(1);
      expect(rows.filter((row) => !row.canonical)).toHaveLength(1);
    });

    it("leaves the cursor untouched when the chain still agrees", async () => {
      await setSinkHead(WINDOW_START + 500);
      await insertRawSnapshot(ORPHAN_BLOCK);
      await promote(WINDOW_START + 600);

      const before = await readApplicationCursor(db, CHAIN_ID, STREAM_KEY);

      const outcome = await reconcileDeepReorg({
        db,
        chainId: CHAIN_ID,
        canonicalHashAt: (blockNumber) => Promise.resolve(chainHashAt(blockNumber)),
      });

      expect(outcome.orphaned).toHaveLength(0);
      expect(outcome.rewoundTo).toBeNull();
      expect((await readApplicationCursor(db, CHAIN_ID, STREAM_KEY))?.blockHash).toBe(
        before?.blockHash,
      );
    });

    it("refuses to infer a reorg from a provider that cannot answer", async () => {
      await setSinkHead(WINDOW_START + 500);
      await insertRawSnapshot(ORPHAN_BLOCK);
      await promote(WINDOW_START + 600);

      // A missing answer is a provider problem. Treating it as a reorg would destroy good evidence
      // on a bad connection.
      await expect(
        reconcileDeepReorg({
          db,
          chainId: CHAIN_ID,
          canonicalHashAt: () => Promise.resolve(null),
        }),
      ).rejects.toThrow(/refusing to infer a reorg/);

      expect(await db.select().from(vaultFlow)).toHaveLength(0);
      expect((await db.select().from(vaultSnapshot))[0]!.canonical).toBe(true);
      expect(await db.select().from(indexerCursor)).toHaveLength(1);
    });
  });
});
