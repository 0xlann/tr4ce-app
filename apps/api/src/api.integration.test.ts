import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  migrate,
  provisionTestDatabase,
  seedRegistry,
  vaultId as deriveVaultId,
  vaultSnapshotId,
  vaultFlowId,
  writeApplicationCursor,
  type Database,
} from "@tr4ce/db";
import { canonicalJson, type PolicyV1 } from "@tr4ce/domain";
import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp, type App } from "./app.js";

/**
 * The HTTP surface against a real database.
 *
 * Exercised through `app.request()` rather than a bound port: the routing, parsing and error
 * handling under test are all inside the Hono app, and a socket would add a moving part without
 * adding coverage.
 *
 * The chain seam is stubbed to a fixed timestamp. That is the whole of what the API asks a provider
 * — resolving a deployment block to a time — and pinning it keeps these assertions about our own
 * code rather than about a provider's availability. Every number in a report comes from a promoted
 * row, and those are written here.
 *
 * Gated on TR4CE_TEST_DATABASE_URL like the other database suites, so `pnpm test` stays green with
 * nothing running.
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = 8453;
const SCHEMA_VERSION = "1.0.0";
const STREAM_KEY = "erc4626-api-test";
const GENERATED_AT = new Date("2026-09-07T00:00:00.000Z");

const WINDOW_START = Math.min(
  ...baseUsdcVaultManifest.vaults.map((entry) => Number(entry.windowStartBlock)),
);

const VAULT = baseUsdcVaultManifest.vaults[0]!;
const ADDRESS = VAULT.address.toLowerCase();

const START_BLOCK = WINDOW_START;
// Roughly seven days of Base blocks after the start, so a seven-day window reaches back to it.
const END_BLOCK = WINDOW_START + 302_400;

const hash = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;
const OWNER = "0x00000000000000000000000000000000000000aa";

const POLICY: PolicyV1 = {
  version: 1,
  underlyingAssets: ["USDC"],
  minHistoryDays: 7,
  minTvlAssets: "1000000",
  minObservedReturnBps: { windowDays: 7, value: 10 },
  minWithdrawableAssets: { owner: OWNER, value: "1000000" },
};

const body = (payload: unknown) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) satisfies RequestInit;

describe.skipIf(url === undefined)("evidence API", () => {
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;
  let app: App;

  beforeAll(async () => {
    const databaseUrl = await provisionTestDatabase(url!, "api");

    handle = createDatabase(databaseUrl, { max: 4 });
    db = handle.db;

    await db.execute(
      sql.raw(
        readFileSync(join(here, "..", "..", "..", "substreams", "erc4626", "schema.sql"), "utf8"),
      ),
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

    app = createApp({
      db,
      chain: { blockTimestamp: async () => "2026-01-01T00:00:00.000Z" },
      calculationVersion: "1.0.0",
      streamKey: STREAM_KEY,
      blockSeconds: 2,
      now: () => GENERATED_AT,
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE rule_result, report_observation, evidence_report, rpc_observation,
                   policy_rule, policy_version, policy, wallet,
                   vault_flow, vault_snapshot, indexer_cursor`,
    );
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — promoted rows, written directly. Promotion itself is @tr4ce/db's suite.
  // -------------------------------------------------------------------------------------------

  async function seedObservations(options: { endAssets?: string } = {}) {
    const vaultRowId = deriveVaultId(CHAIN_ID, ADDRESS);
    const capabilityId = (
      await db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM vault_capability WHERE vault_id = ${vaultRowId} LIMIT 1`,
      )
    )[0]!.id;

    for (const [index, block] of [START_BLOCK, END_BLOCK].entries()) {
      const blockHash = hash(String(index + 1));
      const oneShareAssets = index === 0 ? "1000000" : (options.endAssets ?? "1010000");

      await db.execute(sql`
        INSERT INTO vault_snapshot (
          id, vault_id, capability_id, chain_id, block_number, block_hash, block_time,
          total_assets, total_supply, one_share_units, one_share_assets, call_status, call_errors,
          trigger_activity, trigger_checkpoint, trigger_anchor, canonical, schema_version
        ) VALUES (
          ${vaultSnapshotId(CHAIN_ID, ADDRESS, blockHash, SCHEMA_VERSION)}::uuid, ${vaultRowId}::uuid,
          ${capabilityId}::uuid, ${CHAIN_ID}, ${String(block)}::numeric, decode(${blockHash.slice(2)}, 'hex'),
          ${new Date(1_756_000_000_000 + block * 2000).toISOString()}::timestamptz,
          '417000000000'::numeric, '400000000000'::numeric, '1000000'::numeric,
          ${oneShareAssets}::numeric, 'ok', '[]'::jsonb, true, false, false, true, ${SCHEMA_VERSION}
        )
      `);
    }

    const txHash = hash("a");

    await db.execute(sql`
      INSERT INTO vault_flow (
        id, vault_id, chain_id, block_number, block_hash, block_time, transaction_hash, log_index,
        kind, transfer_kind, sender, owner, receiver, assets, shares, canonical, schema_version
      ) VALUES (
        ${vaultFlowId(CHAIN_ID, hash("2"), txHash, 0, "deposit")}::uuid, ${vaultRowId}::uuid,
        ${CHAIN_ID}, ${String(END_BLOCK - 1)}::numeric, decode(${hash("2").slice(2)}, 'hex'),
        ${new Date(1_756_000_000_000 + (END_BLOCK - 1) * 2000).toISOString()}::timestamptz,
        decode(${txHash.slice(2)}, 'hex'), 0, 'deposit', NULL,
        decode(${OWNER.slice(2)}, 'hex'), decode(${OWNER.slice(2)}, 'hex'),
        decode(${OWNER.slice(2)}, 'hex'), '5000000'::numeric, '4950000'::numeric, true, ${SCHEMA_VERSION}
      )
    `);

    await db.transaction((tx) =>
      writeApplicationCursor(tx, {
        chainId: CHAIN_ID,
        streamKey: STREAM_KEY,
        blockNumber: END_BLOCK,
        blockHash: hash("2"),
        schemaVersion: SCHEMA_VERSION,
      }),
    );
  }

  const request = (windowDays = 7, policy: PolicyV1 = POLICY) =>
    body({
      chainId: CHAIN_ID,
      vaultAddress: ADDRESS,
      windowDays,
      policy,
      policyName: "conservative",
    });

  const countReports = async () =>
    Number(
      (
        await db.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM evidence_report`,
        )
      )[0]!.count,
    );

  // -------------------------------------------------------------------------------------------

  describe("GET /v1/vaults", () => {
    it("lists the curated registry against the shared schema", async () => {
      const response = await app.request("/v1/vaults?chainId=8453");
      const payload = (await response.json()) as { vaults: { address: string }[] };

      expect(response.status).toBe(200);
      expect(payload.vaults).toHaveLength(baseUsdcVaultManifest.vaults.length);
      expect(payload.vaults.map((entry) => entry.address)).toContain(ADDRESS);
    });

    it("rejects a chainId that is not a positive integer", async () => {
      const response = await app.request("/v1/vaults?chainId=nonsense");

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    });
  });

  describe("POST /v1/reports", () => {
    it("produces a report from promoted observations", async () => {
      await seedObservations();

      const response = await app.request("/v1/reports", request());
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.created).toBe(true);
      expect(payload.report.reportId).toMatch(/^trc_[0-9a-f]{32}$/);
      // 1000000 -> 1010000 is a one percent gain, which is 100 basis points, floored.
      expect(payload.report.observations.shareValue.returnBps).toBe(100);
      // The deposit is counted; nothing else moved assets.
      expect(payload.report.observations.netFlowAssets).toBe("5000000");
    });

    it("returns the stored report on a repeat request and writes no second row", async () => {
      /*
       * Task 6's acceptance clause: repeating a request over identical inputs returns the same
       * report. Counted in the table rather than compared in the response — an implementation that
       * returned an equal report while quietly inserting a duplicate would satisfy a response
       * check and still be wrong.
       */
      await seedObservations();

      /*
       * The second request is served by an app whose clock reads twelve hours later. That is the
       * point: `generatedAt` used to be inside the hashed surface, so before that was fixed these
       * two requests produced two ids and two rows. Pinning one clock for both would let this pass
       * without testing the thing it claims to test.
       */
      const later = createApp({
        db,
        chain: { blockTimestamp: async () => "2026-01-01T00:00:00.000Z" },
        calculationVersion: "1.0.0",
        streamKey: STREAM_KEY,
        blockSeconds: 2,
        now: () => new Date(GENERATED_AT.getTime() + 12 * 60 * 60 * 1000),
      });

      const first = await app.request("/v1/reports", request());
      const second = await later.request("/v1/reports", request());

      const one = await first.json();
      const two = await second.json();

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(two.created).toBe(false);
      expect(two.report.reportId).toBe(one.report.reportId);
      expect(canonicalJson(two.report)).toBe(canonicalJson(one.report));
      expect(await countReports()).toBe(1);
    });

    it("still reports when the window reaches further back than our index", async () => {
      /*
       * A window is a request, not a guarantee. Refusing outright would throw away evidence we do
       * have; instead the earliest observation we hold opens the window, and the report says so
       * three ways: the measured spacing, a limitation naming the shortfall, and the history rule
       * reporting UNKNOWN because our coverage falls short rather than because the vault is young.
       *
       * Nothing is quoted over a period it was not measured over, which is the line that matters.
       */
      await seedObservations();

      const response = await app.request(
        "/v1/reports",
        // 30 days demanded, 7 days observed. The threshold the rule measures against is the
        // policy's, not the requested window — those are different questions and the first draft
        // of this test conflated them.
        request(365, { ...POLICY, minHistoryDays: 30 }),
      );
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.report.limitations).toContainEqual(
        expect.stringContaining("Requested window is 365 days"),
      );

      const history = payload.report.policy.rules.find(
        (rule: { key: string }) => rule.key === "minimumHistory",
      );

      // Our coverage falls short; the vault is not young. The reason code says which.
      expect(history.status).toBe("UNKNOWN");
      expect(history.observedValue).toBe("7.00 days");
      expect(history.reasonCodes).toContain("MISSING_OBSERVATION");
    });

    it("answers 404 for an address the registry has never heard of", async () => {
      const response = await app.request(
        "/v1/reports",
        body({
          chainId: CHAIN_ID,
          vaultAddress: "0x000000000000000000000000000000000000dead",
          windowDays: 7,
          policy: POLICY,
        }),
      );

      const payload = await response.json();

      expect(response.status).toBe(404);
      expect(payload.error.code).toBe("UNKNOWN_VAULT");
      // Distinct from a gap in our observations, and the reason code says which.
      expect(payload.error.reasonCodes).toContain("UNSUPPORTED_VAULT");
    });

    it("answers 409 when nothing has been promoted yet", async () => {
      const response = await app.request("/v1/reports", request());
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error.code).toBe("INSUFFICIENT_OBSERVATIONS");
      expect(payload.error.reasonCodes).toContain("MISSING_OBSERVATION");
    });

    it("rejects a policy carrying a key nobody defined", async () => {
      // The strict schema is the LLM trust boundary and it holds at the HTTP edge too.
      await seedObservations();

      const response = await app.request(
        "/v1/reports",
        body({
          chainId: CHAIN_ID,
          vaultAddress: ADDRESS,
          windowDays: 7,
          policy: { ...POLICY, minSharpeRatio: 2 },
        }),
      );

      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("INVALID_REQUEST");
      expect(payload.error.issues.length).toBeGreaterThan(0);
    });

    it("answers with the envelope rather than a stack trace for malformed JSON", async () => {
      const response = await app.request("/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    });
  });

  describe("GET /v1/reports/:id", () => {
    it("returns exactly what was stored", async () => {
      await seedObservations();

      const created = await (await app.request("/v1/reports", request())).json();
      const fetched = await app.request(`/v1/reports/${created.report.reportId}`);
      const payload = await fetched.json();

      expect(fetched.status).toBe(200);
      // Canonical form, not raw bytes: result_json is jsonb and PostgreSQL is free to reorder keys
      // on storage. What must survive is the content, which this compares exactly.
      expect(canonicalJson(payload.report)).toBe(canonicalJson(created.report));
    });

    it("answers 404 for an id nobody stored", async () => {
      const response = await app.request(`/v1/reports/trc_${"0".repeat(32)}`);

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND");
    });
  });

  describe("POST /v1/policies/evaluate", () => {
    it("evaluates a valid policy without storing anything", async () => {
      await seedObservations();

      const response = await app.request(
        "/v1/policies/evaluate",
        body({ chainId: CHAIN_ID, vaultAddress: ADDRESS, windowDays: 7, policy: POLICY }),
      );

      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.evaluation.rules).toHaveLength(5);
      expect(payload.issues).toEqual([]);
      // Evaluating a candidate is a question, not a claim. Nothing was written.
      expect(await countReports()).toBe(0);
      expect(
        Number(
          (
            await db.execute<{ count: string }>(
              sql`SELECT count(*)::text AS count FROM policy_version`,
            )
          )[0]!.count,
        ),
      ).toBe(0);
    });

    it("answers an invalid draft with its issues rather than an error", async () => {
      // TR-F-024: a user has to be shown what is wrong before a policy is stored, so this is a
      // normal outcome carrying detail, not a failure carrying an envelope.
      const response = await app.request(
        "/v1/policies/evaluate",
        body({
          chainId: CHAIN_ID,
          vaultAddress: ADDRESS,
          windowDays: 7,
          policy: { ...POLICY, minTvlAssets: 2_500_000 },
        }),
      );

      const payload = await response.json();

      expect(response.status).toBe(422);
      expect(payload.evaluation).toBeNull();
      expect(payload.issues.map((issue: { path: string }) => issue.path)).toContain("minTvlAssets");
    });
  });

  describe("unrouted paths", () => {
    it("answers with the envelope", async () => {
      const response = await app.request("/v1/nothing-here");

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("REPORT_NOT_FOUND");
    });
  });
});
