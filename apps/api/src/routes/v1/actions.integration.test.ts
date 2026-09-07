import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PreparedCall, SimulationResult } from "@tr4ce/chain";
import {
  createDatabase,
  migrate,
  provisionTestDatabase,
  seedRegistry,
  vaultId as deriveVaultId,
  type Database,
} from "@tr4ce/db";
import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { sql } from "drizzle-orm";
import { encodeFunctionData, keccak256 } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp, type App } from "../../app.js";
import type { ActionChain, PrepareOutcome } from "../../services/action-service.js";

/**
 * The action routes against a real database.
 *
 * The chain is a fixture, deliberately. What the chain actually does with these calls is proven
 * against a writable Anvil fork in `packages/chain/src/actions.fork.test.ts` — including the two
 * findings that fork produced. What is unproven until here is the wiring: that a refusal becomes
 * the shared error envelope rather than a 500, that a prepared action is persisted with its
 * simulation, that a hash can only enter by being reported, and that signability is judged against
 * the chain now rather than read back from the row.
 *
 * Running both through one fork would make this suite slower and neither answer clearer.
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = 8453;
const NOW = new Date("2026-09-07T00:00:00.000Z");
const BLOCK = 50_879_900n;

const VAULT = baseUsdcVaultManifest.vaults[0]!.address.toLowerCase();
const USDC = baseUsdcVaultManifest.canonicalAssets[0]!.address.toLowerCase();
const OWNER = "0x00000000000000000000000000000000000000aa";

const erc20 = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const approveCall = (amount: bigint): PreparedCall => ({
  chainId: CHAIN_ID,
  to: USDC as `0x${string}`,
  data: encodeFunctionData({
    abi: erc20,
    functionName: "approve",
    args: [VAULT as `0x${string}`, amount],
  }),
  value: "0",
  kind: "approve",
});

const depositCall: PreparedCall = {
  chainId: CHAIN_ID,
  to: VAULT as `0x${string}`,
  data: "0x6e553f65",
  value: "0",
  kind: "deposit",
};

/**
 * A chain that answers whatever the test needs.
 *
 * Mutable so a single test can move the block and watch an action stop being signable, which is the
 * behaviour the binding exists for.
 */
class FixtureChain implements ActionChain {
  outcome: PrepareOutcome = { ok: true, calls: [approveCall(1_000_000n), depositCall], previewed: 900_000n };
  blockNumber = BLOCK;
  simulationStatus: "SUCCEEDED" | "FAILED" = "SUCCEEDED";

  async prepareDeposit(): Promise<PrepareOutcome> {
    return this.outcome;
  }

  async prepareRedeem(): Promise<PrepareOutcome> {
    return this.outcome;
  }

  async currentBlock() {
    return {
      number: this.blockNumber,
      hash: `0x${"a".repeat(64)}` as `0x${string}`,
      timestamp: Math.floor(NOW.getTime() / 1000),
    };
  }

  async simulate(input: Parameters<ActionChain["simulate"]>[0]): Promise<SimulationResult> {
    const succeeded = this.simulationStatus === "SUCCEEDED";

    return {
      status: this.simulationStatus,
      binding: {
        chainId: input.call.chainId,
        account: input.account as `0x${string}`,
        to: input.call.to,
        dataHash: keccak256(input.call.data),
        value: input.call.value,
        blockNumber: input.blockNumber.toString(),
        blockHash: input.blockHash,
        capabilityVersion: input.capabilityVersion,
      },
      // Null for a failure. There is no gas figure for a call that did not happen.
      gasEstimate: succeeded ? 182_000n : null,
      revertData: succeeded ? null : "0x",
      message: succeeded ? null : "execution reverted",
      expiresAtBlock: input.blockNumber + 3n,
      expiresAt: new Date((input.blockTimestamp + 60) * 1000).toISOString(),
    };
  }
}

const body = (payload: unknown) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) satisfies RequestInit;

describe.skipIf(url === undefined)("action routes", () => {
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;
  let chain: FixtureChain;
  let app: App;

  beforeAll(async () => {
    const databaseUrl = await provisionTestDatabase(url!, "actions");

    handle = createDatabase(databaseUrl, { max: 4 });
    db = handle.db;

    await db.execute(
      sql.raw(
        readFileSync(
          join(here, "..", "..", "..", "..", "..", "substreams", "erc4626", "schema.sql"),
          "utf8",
        ),
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
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE transaction_receipt, simulation, prepared_action,
                   rule_result, report_observation, evidence_report,
                   policy_rule, policy_version, policy, wallet`,
    );

    chain = new FixtureChain();
    app = createApp({
      db,
      chain: { blockTimestamp: async () => "2026-01-01T00:00:00.000Z" },
      actionChain: chain,
      providerKey: "fixture",
      calculationVersion: "1.0.0",
      streamKey: "erc4626-actions-test",
      blockSeconds: 2,
      now: () => NOW,
    });
  });

  const prepare = (overrides: Record<string, unknown> = {}) =>
    body({
      chainId: CHAIN_ID,
      vaultAddress: VAULT,
      operation: "deposit",
      owner: OWNER,
      receiver: OWNER,
      amount: "1000000",
      ...overrides,
    });

  const count = async (table: string) =>
    Number(
      (
        await db.execute<{ count: string }>(
          sql.raw(`SELECT count(*)::text AS count FROM ${table}`),
        )
      )[0]!.count,
    );

  // ---------------------------------------------------------------------------------------------

  describe("POST /v1/actions/prepare", () => {
    it("returns both unsigned calls and stores the action with its simulation", async () => {
      const response = await app.request("/v1/actions/prepare", prepare());
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.action.actionId).toMatch(/^act_[0-9a-f]{32}$/);
      // The approval and the deposit, in signing order.
      expect(payload.action.transactions).toHaveLength(2);
      expect(payload.action.transactions[0].to.toLowerCase()).toBe(USDC);
      expect(payload.action.simulation.status).toBe("SUCCEEDED");

      expect(await count("prepared_action")).toBe(1);
      // One attempt, appended rather than folded into the action row.
      expect(await count("simulation")).toBe(1);
      // And a wallet for the owner, keyed the way a policy's owner already is.
      expect(await count("wallet")).toBe(1);
    });

    it("carries no signature field anywhere in the response", async () => {
      /*
       * ERD section 7 in four words: "No signature is stored." Checked on the wire as well as in
       * the schema, because a response is what a caller actually sees and a leaked field would be
       * discovered by them rather than by us.
       */
      const payload = await (await app.request("/v1/actions/prepare", prepare())).text();

      for (const forbidden of ["signature", "signed", "privateKey", "rawTransaction", "\"v\":", "\"r\":", "\"s\":"]) {
        expect(payload).not.toContain(forbidden);
      }
    });

    it("names the same action when the same request is repeated", async () => {
      // Idempotent on the binding, for the same reason report creation is on its inputs: preparing
      // twice under unchanged conditions must not leave a user choosing between two rows.
      const first = await (await app.request("/v1/actions/prepare", prepare())).json();
      const second = await (await app.request("/v1/actions/prepare", prepare())).json();

      expect(second.action.actionId).toBe(first.action.actionId);
      expect(await count("prepared_action")).toBe(1);
      // Two attempts against one action: the simulation table is append-only on purpose.
      expect(await count("simulation")).toBe(2);
    });

    it("turns a chain refusal into the shared envelope, not a 500", async () => {
      chain.outcome = { ok: false, code: "INSUFFICIENT_BALANCE" };

      const response = await app.request("/v1/actions/prepare", prepare());
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error.code).toBe("ACTION_NOT_AVAILABLE");
      // Worded for a person, not the internal code.
      expect(payload.error.message).toMatch(/balance/i);
      expect(await count("prepared_action")).toBe(0);
    });

    it("stores a failed simulation rather than discarding it", async () => {
      /*
       * A refused action that leaves no trace is one nobody can explain afterwards. The action is
       * stored, the attempt is stored, and the response says the simulation failed — with no gas
       * figure, because there is none for a call that did not happen.
       */
      chain.simulationStatus = "FAILED";

      const payload = await (await app.request("/v1/actions/prepare", prepare())).json();

      expect(payload.action.simulation.status).toBe("FAILED");
      expect(payload.action.simulation.gasEstimate).toBeNull();
      expect(payload.action.simulation.reasonCodes).toContain("SIMULATION_REVERTED");
      expect(await count("simulation")).toBe(1);
    });

    it("rejects an amount sent as a JSON number", async () => {
      // A uint256 does not survive a double, and the schema refuses the coercion rather than
      // performing it.
      const response = await app.request("/v1/actions/prepare", prepare({ amount: 1000000 }));

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    });

    it("answers 404 for a vault the registry has never heard of", async () => {
      const response = await app.request(
        "/v1/actions/prepare",
        prepare({ vaultAddress: "0x000000000000000000000000000000000000dead" }),
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("UNKNOWN_VAULT");
    });
  });

  describe("GET /v1/actions/:id", () => {
    it("is signable while both budgets hold", async () => {
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const status = await (
        await app.request(`/v1/actions/${prepared.action.actionId}`)
      ).json();

      expect(status.signable).toBe(true);
      expect(status.status).toBe("simulated");
      expect(status.reason).toBeNull();
    });

    it("stops being signable once the chain moves past the block budget", async () => {
      /*
       * Judged against the chain now, which is the whole reason this endpoint recomputes instead of
       * echoing the stored status. Three blocks is about six seconds on Base, so this is the bound
       * that fires in practice.
       */
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();

      chain.blockNumber = BLOCK + 4n;

      const status = await (
        await app.request(`/v1/actions/${prepared.action.actionId}`)
      ).json();

      expect(status.signable).toBe(false);
      expect(status.reason).toBe("BLOCK_BUDGET_SPENT");
      // Still "simulated": the action was not invalidated, its budget was spent.
      expect(status.status).toBe("simulated");
    });

    it("reports a failed simulation as such, never as an expiry", async () => {
      // Reporting it as expired would suggest resimulating helps, and the user would repeat a
      // transaction the chain has already refused.
      chain.simulationStatus = "FAILED";

      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const status = await (
        await app.request(`/v1/actions/${prepared.action.actionId}`)
      ).json();

      expect(status.signable).toBe(false);
      expect(status.reason).toBe("SIMULATION_FAILED");
    });

    it("answers 404 for an id nobody prepared", async () => {
      const response = await app.request(`/v1/actions/act_${"0".repeat(32)}`);

      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("ACTION_NOT_FOUND");
    });
  });

  describe("POST /v1/actions/:id/submitted", () => {
    it("records a hash the caller reports and marks the action submitted", async () => {
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();

      const response = await app.request(
        `/v1/actions/${prepared.action.actionId}/submitted`,
        body({ chainId: CHAIN_ID, transactionHash: `0x${"c".repeat(64)}` }),
      );

      const status = await response.json();

      expect(response.status).toBe(200);
      expect(status.status).toBe("submitted");
      // Submitted is not signable, and for a different reason than expired — signing again would
      // send the same transaction twice.
      expect(status.signable).toBe(false);
      expect(await count("transaction_receipt")).toBe(1);
    });

    it("refuses a second report for the same action", async () => {
      /*
       * Two hashes for one action means either a duplicate submission or a mix-up. Overwriting the
       * first would erase the evidence of which, so the second is refused.
       */
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const submit = () =>
        app.request(
          `/v1/actions/${prepared.action.actionId}/submitted`,
          body({ chainId: CHAIN_ID, transactionHash: `0x${"c".repeat(64)}` }),
        );

      expect((await submit()).status).toBe(200);

      const second = await submit();

      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe("ACTION_NOT_AVAILABLE");
      expect(await count("transaction_receipt")).toBe(1);
    });

    it("answers 404 for an action nobody prepared", async () => {
      const response = await app.request(
        `/v1/actions/act_${"0".repeat(32)}/submitted`,
        body({ chainId: CHAIN_ID, transactionHash: `0x${"c".repeat(64)}` }),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("a deployment with no chain wired for actions", () => {
    it("answers 501 rather than pretending to prepare something", async () => {
      const readOnly = createApp({
        db,
        chain: { blockTimestamp: async () => null },
        calculationVersion: "1.0.0",
        streamKey: "erc4626-actions-test",
        blockSeconds: 2,
        now: () => NOW,
      });

      const response = await readOnly.request("/v1/actions/prepare", prepare());

      expect(response.status).toBe(501);
      // Still the shared envelope: a capability that was never wired up is not an excuse to
      // answer in a shape nobody parses.
      expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
    });
  });
});
