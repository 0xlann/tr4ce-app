import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "./client.js";
import { vaultId as deriveVaultId, walletId as deriveWalletId } from "./ids.js";
import { migrate } from "./migrate.js";
import {
  insertPreparedAction,
  invalidateAction,
  recordSubmission,
  readAction,
  type InsertActionInput,
} from "./repositories/actions.js";
import { seedRegistry } from "./repositories/vaults.js";
import { hexToBytes } from "./schema/columns.js";
import { wallet } from "./schema/policies.js";
import { provisionTestDatabase } from "./testing.js";

/**
 * Prepared-action persistence against a real PostgreSQL instance.
 *
 * What is checked here cannot be checked anywhere else: the partial unique index that scopes
 * idempotency to live actions, the composite foreign key that keeps an action's report about the
 * action's own vault, and the CHECK that refuses a terminal status with no reason. All three are
 * properties of the schema — a repository test with a fake would pass while the database refused.
 *
 * The routes over these functions are covered in `apps/api`; this suite is about the constraints.
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = 8453;
const OWNER = "0x00000000000000000000000000000000000000aa";
const VAULT_A = baseUsdcVaultManifest.vaults[0]!.address.toLowerCase();
const VAULT_B = baseUsdcVaultManifest.vaults[1]!.address.toLowerCase();

const digest = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;

/**
 * The full text of a refused query, cause included.
 *
 * postgres.js puts the constraint name on `error.cause`, so `toThrow(/name/)` would be matching the
 * SQL text in the message instead — and would pass for a query refused by something else entirely.
 */
const rejection = async (promise: PromiseLike<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string; message?: string } }).cause;

    return `${String(error)} ${cause?.constraint_name ?? ""} ${cause?.message ?? ""}`;
  }

  throw new Error("Expected the query to be refused, but it succeeded.");
};

const call = (to: string, kind: "approve" | "deposit") => ({
  chainId: CHAIN_ID,
  to,
  data: "0x6e553f65",
  value: "0",
  kind,
});

describe.skipIf(url === undefined)("prepared action persistence", () => {
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;

  beforeAll(async () => {
    // Its own database. Turbo runs package tasks in parallel and two suites rebuilding one schema
    // would tear it down under each other.
    const databaseUrl = await provisionTestDatabase(url!, "actions_db");

    handle = createDatabase(databaseUrl, { max: 2 });
    db = handle.db;

    await db.execute(
      sql.raw(readFileSync(join(here, "..", "..", "..", "substreams", "erc4626", "schema.sql"), "utf8")),
    );

    await migrate(databaseUrl);

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
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE transaction_receipt, simulation, prepared_action,
                         rule_result, report_observation, evidence_report,
                         policy_rule, policy_version, policy, wallet`);

    await db
      .insert(wallet)
      .values({ id: deriveWalletId(OWNER), chainScope: null, address: hexToBytes(OWNER) })
      .onConflictDoNothing({ target: wallet.id });
  });

  const input = (overrides: Partial<InsertActionInput> = {}): InsertActionInput => ({
    actionId: `act_${randomUUID().replaceAll("-", "").slice(0, 32)}`,
    walletId: deriveWalletId(OWNER),
    vaultId: deriveVaultId(CHAIN_ID, VAULT_A),
    reportId: null,
    kind: "deposit",
    chainId: CHAIN_ID,
    account: OWNER,
    calldataHash: digest("1"),
    capabilityVersion: "morpho-blue@1.0.0",
    transactions: [call(VAULT_A, "approve"), call(VAULT_A, "deposit")],
    previewed: 900_000n,
    expiresAt: new Date("2026-09-08T00:01:00.000Z"),
    ...overrides,
  });

  // -------------------------------------------------------------------------------------------

  it("returns the live action rather than a second row under the same digest", async () => {
    const first = await db.transaction((tx) => insertPreparedAction(tx, input()));
    const second = await db.transaction((tx) => insertPreparedAction(tx, input()));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.action.actionId).toBe(first.action.actionId);
  });

  it("prepares a fresh action once the earlier one has been sent", async () => {
    /*
     * The partial index stops covering an action the moment it leaves `prepared`/`simulated`.
     *
     * This is what makes a repeated deposit possible at all. TR4CE's approval is exact, so a
     * completed deposit leaves the allowance back at zero and the same request is a new intent to
     * spend — under a plain UNIQUE, or a content-derived id, it would be unpreparable forever.
     */
    const first = await db.transaction((tx) => insertPreparedAction(tx, input()));

    await db.transaction(async (tx) => {
      await recordSubmission(tx, {
        actionId: first.action.actionId,
        callIndex: 0,
        chainId: CHAIN_ID,
        transactionHash: digest("a"),
      });
      await recordSubmission(tx, {
        actionId: first.action.actionId,
        callIndex: 1,
        chainId: CHAIN_ID,
        transactionHash: digest("b"),
      });
    });

    const second = await db.transaction((tx) => insertPreparedAction(tx, input()));

    expect(second.created).toBe(true);
    expect(second.action.actionId).not.toBe(first.action.actionId);
  });

  it("counts a re-reported hash once", async () => {
    const { action } = await db.transaction((tx) => insertPreparedAction(tx, input()));

    await db.transaction((tx) =>
      recordSubmission(tx, {
        actionId: action.actionId,
        callIndex: 0,
        chainId: CHAIN_ID,
        transactionHash: digest("a"),
      }),
    );
    await db.transaction((tx) =>
      recordSubmission(tx, {
        actionId: action.actionId,
        callIndex: 0,
        chainId: CHAIN_ID,
        transactionHash: digest("a"),
      }),
    );

    const stored = await readAction(db, action.actionId);

    expect(stored?.sentCount).toBe(1);
    // Two calls, one reported: not submitted, and the CHECK in 0004 would refuse it if it were.
    expect(stored?.status).toBe("prepared");
  });

  it("refuses a report that would put the count ahead of the calls", async () => {
    // `sent_count <= jsonb_array_length(transactions_json)` is a database rule, so a repository
    // bug cannot talk its way past it.
    const { action } = await db.transaction((tx) =>
      insertPreparedAction(tx, input({ transactions: [call(VAULT_A, "deposit")] })),
    );

    expect(
      await rejection(
        db.execute(sql`UPDATE prepared_action SET sent_count = 2 WHERE id = ${action.actionId}`),
      ),
    ).toContain("prepared_action_sent_count_check");
  });

  it("refuses an action citing a report about a different vault", async () => {
    /*
     * The composite foreign key. A plain REFERENCES evidence_report (id) would accept this, and an
     * action on vault A could carry a report about vault B as its justification — the exact bug
     * report_observation's own composite keys exist to prevent (ERD section 11).
     */
    const reportId = `trc_${"9".repeat(32)}`;

    await db.execute(sql`
      INSERT INTO evidence_report (
        id, vault_id, chain_id, schema_version, calculation_version, canonical_input_hash,
        as_of_block_number, as_of_block_hash, as_of_time, window_seconds, status, result_json
      ) VALUES (
        ${reportId}, ${deriveVaultId(CHAIN_ID, VAULT_B)}, ${CHAIN_ID}, '1.0.0', '1.0.0',
        ${hexToBytes(digest("9"))}, 1, ${hexToBytes(digest("9"))}, now(), 604800, 'not_evaluated', '{}'::jsonb
      )
    `);

    expect(
      await rejection(
        db.transaction((tx) =>
          insertPreparedAction(tx, input({ reportId, vaultId: deriveVaultId(CHAIN_ID, VAULT_A) })),
        ),
      ),
    ).toContain("prepared_action_report_vault_fk");
  });

  it("keeps a terminal status and its reason together", async () => {
    /*
     * `invalidateAction` has no caller inside Task 7 — it is the write side of the reorg path. It
     * is kept and proven here rather than left to be written blind later, and the second half of
     * this test is why: the migration refuses a terminal status with no reason, so a caller that
     * forgot one would fail at the database rather than leave a user an action marked dead with
     * nothing saying why.
     */
    const { action } = await db.transaction((tx) => insertPreparedAction(tx, input()));

    await db.transaction((tx) =>
      invalidateAction(tx, action.actionId, "invalidated", "REORG_INVALIDATED"),
    );

    const stored = await readAction(db, action.actionId);

    expect(stored?.status).toBe("invalidated");
    expect(stored?.invalidatedReason).toBe("REORG_INVALIDATED");

    expect(
      await rejection(
        db.execute(sql`
          UPDATE prepared_action SET status = 'expired', invalidated_reason = NULL
          WHERE id = ${action.actionId}
        `),
      ),
    ).toContain("prepared_action_invalidation_check");
  });
});
