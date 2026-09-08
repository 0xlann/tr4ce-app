import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PolicyEvaluation, PolicyV1 } from "@tr4ce/domain";
import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "./client.js";
import { vaultId as deriveVaultId, vaultSnapshotId } from "./ids.js";
import { migrate } from "./migrate.js";
import { policyContentHash, readPolicyVersion, storePolicyVersion } from "./repositories/policies.js";
import {
  insertReport,
  insertRuleResults,
  listReportCitations,
  readReport,
  ReportCitationError,
} from "./repositories/reports.js";
import { seedRegistry } from "./repositories/vaults.js";
import { hexToBytes } from "./schema/columns.js";
import { vaultSnapshot } from "./schema/observations.js";
import { provisionTestDatabase } from "./testing.js";

/**
 * Report and policy persistence against a real PostgreSQL instance.
 *
 * Idempotency is a property of the schema, not of the repository functions, so it cannot be shown
 * with fakes: the unique index on `(canonical_input_hash, calculation_version, schema_version)` and
 * the canonicality trigger are what actually enforce it, and neither exists outside a database.
 *
 * Gated on TR4CE_TEST_DATABASE_URL, the same way the promotion suite is, so `pnpm test` stays green
 * with no database available.
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = 8453;
const SCHEMA_VERSION = "1.0.0";
const CALCULATION_VERSION = "1.0.0";

const WINDOW_START = Math.min(
  ...baseUsdcVaultManifest.vaults.map((entry) => Number(entry.windowStartBlock)),
);

const ADDRESS_A = baseUsdcVaultManifest.vaults[0]!.address.toLowerCase();
const ADDRESS_B = baseUsdcVaultManifest.vaults[1]!.address.toLowerCase();

const hash = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;
const BLOCK_1 = hash("1");
const OWNER = "0x00000000000000000000000000000000000000aa";

const POLICY: PolicyV1 = {
  version: 1,
  underlyingAssets: ["USDC"],
  minHistoryDays: 30,
  minTvlAssets: "1000000000",
  minObservedReturnBps: { windowDays: 7, value: 25 },
  minWithdrawableAssets: { owner: OWNER, value: "1000000" },
};

const EVALUATION: PolicyEvaluation = {
  version: 1,
  status: "UNKNOWN",
  rules: [
    {
      key: "underlyingAsset",
      status: "PASS",
      threshold: "USDC",
      observedValue: "USDC",
      evidenceReferences: [],
      reasonCodes: [],
    },
    {
      key: "minimumHistory",
      status: "UNKNOWN",
      threshold: "30",
      observedValue: null,
      evidenceReferences: [],
      reasonCodes: ["MISSING_OBSERVATION"],
    },
  ],
};

describe.skipIf(url === undefined)("report and policy persistence", () => {
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;
  let vaultA: string;
  let vaultB: string;

  beforeAll(async () => {
    // Its own database. Turbo runs package tasks in parallel and two suites rebuilding one schema
    // would tear it down under each other.
    const databaseUrl = await provisionTestDatabase(url!, "reports");

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

    vaultA = deriveVaultId(CHAIN_ID, ADDRESS_A);
    vaultB = deriveVaultId(CHAIN_ID, ADDRESS_B);
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE transaction_receipt, simulation, prepared_action,
                   rule_result, report_observation, evidence_report, rpc_observation,
                   policy_rule, policy_version, policy, wallet, vault_snapshot`,
    );
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  /** A promoted snapshot for a report to cite. Written directly: promotion is another suite's job. */
  async function seedSnapshot(
    vaultRowId: string,
    vaultAddress: string,
    options: { canonical?: boolean } = {},
  ): Promise<string> {
    const capabilityId = (
      await db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM vault_capability WHERE vault_id = ${vaultRowId} LIMIT 1`,
      )
    )[0]!.id;

    const id = vaultSnapshotId(CHAIN_ID, vaultAddress, BLOCK_1, SCHEMA_VERSION);

    await db.insert(vaultSnapshot).values({
      id,
      vaultId: vaultRowId,
      capabilityId,
      chainId: CHAIN_ID,
      blockNumber: String(WINDOW_START + 10),
      blockHash: hexToBytes(BLOCK_1),
      blockTime: new Date("2026-09-01T00:00:00.000Z"),
      totalAssets: "417000000000",
      totalSupply: "400000000000",
      oneShareUnits: "1000000",
      oneShareAssets: "1052300",
      callStatus: "ok",
      callErrors: [],
      triggerActivity: true,
      triggerCheckpoint: false,
      triggerAnchor: false,
      canonical: options.canonical ?? true,
      schemaVersion: SCHEMA_VERSION,
    });

    return id;
  }

  const reportInput = (
    reportId: string,
    canonicalInputHash: string,
    overrides: Partial<Parameters<typeof insertReport>[1]> = {},
  ) => ({
    reportId,
    canonicalInputHash,
    vaultId: vaultA,
    chainId: CHAIN_ID,
    policyVersionId: null,
    asOf: {
      blockNumber: String(WINDOW_START + 10),
      blockHash: BLOCK_1,
      timestamp: "2026-09-01T00:00:00.000Z",
    },
    windowSeconds: 7 * 24 * 60 * 60,
    actualElapsedSeconds: 6 * 24 * 60 * 60,
    calculationVersion: CALCULATION_VERSION,
    schemaVersion: SCHEMA_VERSION,
    status: "not_evaluated" as const,
    resultJson: { schemaVersion: SCHEMA_VERSION, reportId },
    citations: [],
    ...overrides,
  });

  const countReports = async () =>
    Number(
      (await db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM evidence_report`))[0]!
        .count,
    );

  // -------------------------------------------------------------------------------------------

  describe("policy versions", () => {
    it("stores a policy and its normalized rule rows in one transaction", async () => {
      const stored = await db.transaction((tx) =>
        storePolicyVersion(tx, { policy: POLICY, name: "conservative", source: "manual" }),
      );

      expect(stored.created).toBe(true);
      expect(stored.versionNumber).toBe(1);
      // All five MVP rules are required by the schema, so all five must be projected.
      expect(stored.rules).toHaveLength(5);

      const rows = await db.execute<{ rule_key: string; operator: string }>(
        sql`SELECT rule_key, operator FROM policy_rule WHERE policy_version_id = ${stored.policyVersionId} ORDER BY ordinal`,
      );

      expect(rows.map((row) => row.rule_key)).toEqual([
        "underlyingAsset",
        "minimumHistory",
        "minimumTvl",
        "minimumObservedReturn",
        "minimumWithdrawableAssets",
      ]);
      expect(rows.map((row) => row.operator)).toEqual(["in", "gte", "gte", "gte", "gte"]);
    });

    it("reuses the existing version when the same policy is submitted again", async () => {
      // Re-saving an unchanged policy must not advance the version history, which would otherwise
      // stop meaning "the policy changed here".
      const first = await db.transaction((tx) =>
        storePolicyVersion(tx, { policy: POLICY, name: "conservative", source: "manual" }),
      );
      const second = await db.transaction((tx) =>
        storePolicyVersion(tx, { policy: POLICY, name: "conservative", source: "manual" }),
      );

      expect(second.created).toBe(false);
      expect(second.policyVersionId).toBe(first.policyVersionId);
      expect(second.versionNumber).toBe(1);
      expect(await countPolicyVersions()).toBe(1);
    });

    it("mints a new version when any threshold changes", async () => {
      await db.transaction((tx) =>
        storePolicyVersion(tx, { policy: POLICY, name: "conservative", source: "manual" }),
      );

      const changed = await db.transaction((tx) =>
        storePolicyVersion(tx, {
          policy: { ...POLICY, minHistoryDays: 60 },
          name: "conservative",
          source: "manual",
        }),
      );

      expect(changed.created).toBe(true);
      expect(changed.versionNumber).toBe(2);
      expect(await countPolicyVersions()).toBe(2);
    });

    it("reads back the exact policy that was stored", async () => {
      const stored = await db.transaction((tx) =>
        storePolicyVersion(tx, { policy: POLICY, name: "conservative", source: "manual" }),
      );

      const read = await readPolicyVersion(db, stored.policyVersionId);

      expect(read).toEqual(POLICY);
      expect(policyContentHash(read!)).toBe(stored.contentHash);
    });

    it("rejects a policy carrying a key nobody defined", async () => {
      // The strict schema is the LLM trust boundary, and it has to hold at the storage layer too:
      // a policy stored with an extra field would evaluate differently from the one confirmed.
      await expect(
        db.transaction((tx) =>
          storePolicyVersion(tx, {
            policy: { ...POLICY, minSharpeRatio: 2 } as unknown as PolicyV1,
            name: "conservative",
            source: "llm_import",
          }),
        ),
      ).rejects.toThrow(/[Uu]nrecognized key/);
    });
  });

  describe("report insertion", () => {
    it("stores a report with its citations", async () => {
      const snapshotId = await seedSnapshot(vaultA, ADDRESS_A);

      const stored = await db.transaction((tx) =>
        insertReport(
          tx,
          reportInput(`trc_${"a".repeat(32)}`, "a".repeat(64), {
            citations: [{ observationType: "snapshot", observationId: snapshotId, purpose: "end" }],
          }),
        ),
      );

      expect(stored.created).toBe(true);
      expect(await listReportCitations(db, stored.reportId)).toHaveLength(1);
    });

    it("returns the stored report instead of writing a second row for the same inputs", async () => {
      /*
       * The acceptance clause, checked by counting rows rather than by comparing responses: an
       * implementation that returned an equal report while quietly inserting a duplicate would
       * satisfy a response-equality assertion and still be wrong.
       */
      const snapshotId = await seedSnapshot(vaultA, ADDRESS_A);
      const input = reportInput(`trc_${"b".repeat(32)}`, "b".repeat(64), {
        citations: [{ observationType: "snapshot", observationId: snapshotId, purpose: "end" }],
      });

      const first = await db.transaction((tx) => insertReport(tx, input));
      const second = await db.transaction((tx) => insertReport(tx, input));

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.reportId).toBe(first.reportId);
      expect(second.resultJson).toEqual(first.resultJson);
      expect(await countReports()).toBe(1);
    });

    it("refuses to store a report that cites nothing", async () => {
      // A claim with no citations cannot be checked, and being checkable is the whole product.
      await expect(
        db.transaction((tx) =>
          insertReport(tx, reportInput(`trc_${"c".repeat(32)}`, "c".repeat(64))),
        ),
      ).rejects.toThrow(ReportCitationError);
    });

    it("refuses to build a report from a non-canonical observation", async () => {
      /*
       * ERD section 11, enforced by the trigger rather than by this repository. The distinction
       * matters: the rule exists to protect against application bugs, and a rule enforced only by
       * the code it guards is not enforced at all.
       */
      const snapshotId = await seedSnapshot(vaultA, ADDRESS_A, { canonical: false });

      const failure = await db
        .transaction((tx) =>
          insertReport(
            tx,
            reportInput(`trc_${"d".repeat(32)}`, "d".repeat(64), {
              citations: [
                { observationType: "snapshot", observationId: snapshotId, purpose: "end" },
              ],
            }),
          ),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).not.toBeNull();
      expect(String((failure as { cause?: { message?: string } }).cause?.message)).toMatch(
        /non-canonical/,
      );
      // The whole write rolled back: a report without its citations would be a claim with nothing
      // behind it, which is worse than no report.
      expect(await countReports()).toBe(0);
    });

    it("refuses a report on one vault citing another vault's observation", async () => {
      const snapshotOfB = await seedSnapshot(vaultB, ADDRESS_B);

      const failure = await db
        .transaction((tx) =>
          insertReport(
            tx,
            reportInput(`trc_${"e".repeat(32)}`, "e".repeat(64), {
              citations: [
                { observationType: "snapshot", observationId: snapshotOfB, purpose: "end" },
              ],
            }),
          ),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      // The composite foreign key, named, so this cannot pass on some unrelated failure.
      expect(String((failure as { cause?: { constraint_name?: string } }).cause?.constraint_name)).toBe(
        "report_observation_snapshot_vault_fk",
      );
    });
  });

  describe("rule results", () => {
    it("stores one verdict per evaluated rule, tied to the version it was judged against", async () => {
      const snapshotId = await seedSnapshot(vaultA, ADDRESS_A);

      const { reportId, ruleIds, policyVersionId } = await db.transaction(async (tx) => {
        const policy = await storePolicyVersion(tx, {
          policy: POLICY,
          name: "conservative",
          source: "manual",
        });

        const report = await insertReport(
          tx,
          reportInput(`trc_${"f".repeat(32)}`, "f".repeat(64), {
            policyVersionId: policy.policyVersionId,
            status: "unknown",
            citations: [{ observationType: "snapshot", observationId: snapshotId, purpose: "end" }],
          }),
        );

        const ids = Object.fromEntries(policy.rules.map((rule) => [rule.ruleKey, rule.id]));

        await insertRuleResults(tx, {
          reportId: report.reportId,
          policyVersionId: policy.policyVersionId,
          ruleIds: ids as never,
          evaluation: EVALUATION,
          thresholds: {
            underlyingAsset: POLICY.underlyingAssets,
            minimumHistory: POLICY.minHistoryDays,
            minimumTvl: POLICY.minTvlAssets,
            minimumObservedReturn: POLICY.minObservedReturnBps,
            minimumWithdrawableAssets: POLICY.minWithdrawableAssets,
          },
        });

        return {
          reportId: report.reportId,
          ruleIds: ids,
          policyVersionId: policy.policyVersionId,
        };
      });

      const rows = await db.execute<{ status: string; observed_json: unknown; rule: string }>(
        sql`SELECT status, observed_json, policy_rule_id::text AS rule FROM rule_result WHERE report_id = ${reportId} ORDER BY status`,
      );

      expect(rows).toHaveLength(2);
      // Lowercase in storage, uppercase on the wire. One mapping, applied in one place.
      expect(rows.map((row) => row.status).sort()).toEqual(["pass", "unknown"]);
      // An UNKNOWN rule observed nothing, and the NULL says so rather than a zero standing in.
      expect(rows.find((row) => row.status === "unknown")!.observed_json).toBeNull();
      expect(rows.every((row) => Object.values(ruleIds).includes(row.rule))).toBe(true);
      expect(policyVersionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("rejects a PASS that observed nothing", async () => {
      // A verdict with no basis. The CHECK in 0002 is what refuses it, not the repository.
      const snapshotId = await seedSnapshot(vaultA, ADDRESS_A);

      const failure = await db
        .transaction(async (tx) => {
          const policy = await storePolicyVersion(tx, {
            policy: POLICY,
            name: "conservative",
            source: "manual",
          });

          const report = await insertReport(
            tx,
            reportInput(`trc_${"1".repeat(32)}`, "1".repeat(64), {
              policyVersionId: policy.policyVersionId,
              status: "pass",
              citations: [
                { observationType: "snapshot", observationId: snapshotId, purpose: "end" },
              ],
            }),
          );

          await insertRuleResults(tx, {
            reportId: report.reportId,
            policyVersionId: policy.policyVersionId,
            ruleIds: Object.fromEntries(
              policy.rules.map((rule) => [rule.ruleKey, rule.id]),
            ) as never,
            evaluation: {
              version: 1,
              status: "PASS",
              rules: [
                {
                  key: "minimumTvl",
                  status: "PASS",
                  threshold: "1000000000",
                  observedValue: null,
                  evidenceReferences: [],
                  reasonCodes: [],
                },
              ],
            },
            thresholds: { minimumTvl: POLICY.minTvlAssets } as never,
          });
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      // Named, not merely thrown: without checking which constraint fired, a typo anywhere in the
      // fixture would make this pass while proving nothing.
      expect(String((failure as { cause?: { constraint_name?: string } }).cause?.constraint_name)).toBe(
        "rule_result_observed_presence_check",
      );
    });
  });

  describe("reading back", () => {
    it("returns what was served, not a recomputation of it", async () => {
      const snapshotId = await seedSnapshot(vaultA, ADDRESS_A);
      const reportId = `trc_${"2".repeat(32)}`;
      const served = { schemaVersion: SCHEMA_VERSION, reportId, note: "exactly this" };

      await db.transaction((tx) =>
        insertReport(
          tx,
          reportInput(reportId, "2".repeat(64), {
            resultJson: served,
            citations: [{ observationType: "snapshot", observationId: snapshotId, purpose: "end" }],
          }),
        ),
      );

      expect((await readReport(db, reportId))!.resultJson).toEqual(served);
    });

    it("answers null for an id nobody stored", async () => {
      expect(await readReport(db, `trc_${"0".repeat(32)}`)).toBeNull();
    });
  });

  async function countPolicyVersions(): Promise<number> {
    const rows = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM policy_version`,
    );

    return Number(rows[0]!.count);
  }
});
