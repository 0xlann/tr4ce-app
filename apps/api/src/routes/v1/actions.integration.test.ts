import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { erc4626Abi, type ActionReceipt, type PreparedCall, type SimulationResult } from "@tr4ce/chain";
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
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256 } from "viem";
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
  /** Hashes the chain has a receipt for. Absent means "reported but not mined yet". */
  receipts = new Map<string, ActionReceipt>();

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

  async receipt(transactionHash: string): Promise<ActionReceipt | null> {
    return this.receipts.get(transactionHash.toLowerCase()) ?? null;
  }
}

/** A receipt carrying the vault's own Deposit event, as the chain would return it. */
const depositReceipt = (
  transactionHash: `0x${string}`,
  assets: bigint,
  shares: bigint,
): ActionReceipt => ({
  status: "success",
  blockNumber: BLOCK + 1n,
  blockHash: `0x${"b".repeat(64)}`,
  transactionHash,
  gasUsed: 174_000n,
  effectiveGasPrice: 1_000_000n,
  logs: [
    {
      address: VAULT as `0x${string}`,
      topics: encodeEventTopics({
        abi: erc4626Abi,
        eventName: "Deposit",
        args: { sender: OWNER as `0x${string}`, owner: OWNER as `0x${string}` },
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [assets, shares],
      ),
    } as unknown as ActionReceipt["logs"][number],
  ],
});

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

  const submit = (actionId: string, callIndex: number, transactionHash: string) =>
    app.request(
      `/v1/actions/${actionId}/submitted`,
      body({ chainId: CHAIN_ID, callIndex, transactionHash }),
    );

  /** Approve, resimulate, deposit — the whole two-call sequence a wallet performs. */
  const carryThrough = async (actionId: string, approveHash: string, depositHash: string) => {
    await submit(actionId, 0, approveHash);
    // The chain moves once a transaction lands, which is exactly why the deposit needs its own
    // simulation rather than inheriting the approval's.
    chain.blockNumber += 1n;
    await app.request(`/v1/actions/${actionId}/simulate`, { method: "POST" });
    await submit(actionId, 1, depositHash);

    return (await (await app.request(`/v1/actions/${actionId}`)).json()) as Record<string, unknown>;
  };

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

    it("names the same action while the first is still awaiting signature", async () => {
      // Idempotent while the action is live: preparing twice under unchanged conditions must not
      // leave a user choosing between two rows.
      const first = await (await app.request("/v1/actions/prepare", prepare())).json();
      const second = await (await app.request("/v1/actions/prepare", prepare())).json();

      expect(second.action.actionId).toBe(first.action.actionId);
      expect(await count("prepared_action")).toBe(1);
      /*
       * And no second attempt. Re-simulating here would append an attempt for call 0 even when the
       * caller is midway through a two-call deposit and call 1 is what is actually next — the
       * simulate route is where a fresh attempt comes from.
       */
      expect(await count("simulation")).toBe(1);
    });

    it("answers a mid-flight repeat with the call that is actually next", async () => {
      /*
       * A page reload after the approval has been reported re-prepares the same plan. The action is
       * still live, so the same one comes back — but the simulation shown must be the deposit's,
       * not the approval's. Showing the approval's would put a gas figure for a transaction already
       * sent next to a button that signs a different one.
       */
      const first = await (await app.request("/v1/actions/prepare", prepare())).json();
      const id = first.action.actionId;

      await submit(id, 0, `0x${"1".repeat(64)}`);
      chain.blockNumber = BLOCK + 1n;

      const again = await (await app.request("/v1/actions/prepare", prepare())).json();

      expect(again.action.actionId).toBe(id);
      // Simulated against the block the deposit will be signed at, not the approval's.
      expect(again.action.simulation.blockNumber).toBe((BLOCK + 1n).toString());

      const status = await (await app.request(`/v1/actions/${id}`)).json();

      expect(status.signable).toBe(true);
      expect(status.nextCallIndex).toBe(1);
    });

    it("prepares a new action once the first has been sent", async () => {
      /*
       * The other half of that rule, and the reason an action id is generated rather than derived
       * from its calls.
       *
       * TR4CE's approval is exact, so a completed deposit leaves the allowance back at zero and an
       * identical second deposit is a second real thing to do. Under a content-derived id it would
       * have mapped onto the finished action forever and been unpreparable.
       */
      const first = await (await app.request("/v1/actions/prepare", prepare())).json();

      await carryThrough(first.action.actionId, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`);

      const second = await (await app.request("/v1/actions/prepare", prepare())).json();

      expect(second.action.actionId).not.toBe(first.action.actionId);
      expect(await count("prepared_action")).toBe(2);
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
    it("records a hash the caller reports without closing the action early", async () => {
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();

      const response = await submit(prepared.action.actionId, 0, `0x${"c".repeat(64)}`);
      const status = await response.json();

      expect(response.status).toBe(200);
      expect(await count("transaction_receipt")).toBe(1);
      expect(status.sentCount).toBe(1);
      // Two calls, one reported: the deposit is still to come, so the action is not submitted.
      expect(status.status).toBe("prepared");
      expect(status.nextCallIndex).toBe(1);
    });

    it("marks the action submitted only once every call has a hash", async () => {
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const status = await carryThrough(
        prepared.action.actionId,
        `0x${"1".repeat(64)}`,
        `0x${"2".repeat(64)}`,
      );

      expect(status.status).toBe("submitted");
      // Submitted is not signable, and for a different reason than expired — signing again would
      // send the same transaction twice.
      expect(status.signable).toBe(false);
      expect(status.nextCallIndex).toBeNull();
      expect(await count("transaction_receipt")).toBe(2);
    });

    it("accepts the same hash for the same call again", async () => {
      /*
       * How a caller asks TR4CE to look for a receipt that had not been mined the first time.
       * TR4CE never polls on its own, so without this a transaction reported a second too early
       * would stay unobserved forever.
       */
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const id = prepared.action.actionId;
      const hash = `0x${"c".repeat(64)}` as const;

      expect((await submit(id, 0, hash)).status).toBe(200);

      const again = await submit(id, 0, hash);

      expect(again.status).toBe(200);
      // Counted from the receipts that exist, so a re-report cannot advance it.
      expect((await again.json()).sentCount).toBe(1);
      expect(await count("transaction_receipt")).toBe(1);
    });

    it("refuses a different hash for a call already reported", async () => {
      /*
       * Two hashes for one call means either a duplicate submission or a mix-up. Overwriting the
       * first would erase the evidence of which, so the second is refused.
       */
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const id = prepared.action.actionId;

      expect((await submit(id, 0, `0x${"c".repeat(64)}`)).status).toBe(200);

      const second = await submit(id, 0, `0x${"d".repeat(64)}`);

      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe("ACTION_NOT_AVAILABLE");
      expect(await count("transaction_receipt")).toBe(1);
    });

    it("refuses a call reported out of order", async () => {
      // Reporting the deposit before the approval would mean a deposit signed without its
      // allowance, and recording it would put every later signability answer out of step.
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();

      const response = await submit(prepared.action.actionId, 1, `0x${"c".repeat(64)}`);

      expect(response.status).toBe(409);
      expect(await count("transaction_receipt")).toBe(0);
    });

    it("rejects a call index the action does not have", async () => {
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();

      const response = await submit(prepared.action.actionId, 7, `0x${"c".repeat(64)}`);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    });

    it("answers 404 for an action nobody prepared", async () => {
      const response = await submit(`act_${"0".repeat(32)}`, 0, `0x${"c".repeat(64)}`);

      expect(response.status).toBe(404);
    });
  });

  describe("the full two-call deposit", () => {
    it("can be carried through both calls", async () => {
      /*
       * The flagship flow: approve, then deposit. Each call is simulated before it is signed
       * (PRD TR-F-032) and each hash is reported back after the wallet sends it.
       *
       * This is the sequence the fork test performs by hand. Doing it through the routes is the
       * only way to know the API can express it — and before this test it could not: reporting the
       * approval closed the action and the deposit had nowhere to go.
       */
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const id = prepared.action.actionId;

      expect(prepared.action.transactions).toHaveLength(2);
      expect(prepared.action.transactions[0].kind).toBe("approve");
      expect(prepared.action.transactions[1].kind).toBe("deposit");

      // Call 0: the approval. Signable on the strength of its own simulation.
      expect((await (await app.request(`/v1/actions/${id}`)).json()).signable).toBe(true);
      expect((await submit(id, 0, `0x${"1".repeat(64)}`)).status).toBe(200);

      // The chain moves once it lands.
      chain.blockNumber = BLOCK + 1n;

      /*
       * The guard. The deposit is now next, and the only simulation on record is the approval's —
       * which says nothing about whether the deposit will succeed. Answering `signable: true` here
       * would let a wallet sign a deposit on an approval's gas estimate (PRD TR-F-032).
       */
      const beforeResimulating = await (await app.request(`/v1/actions/${id}`)).json();

      expect(beforeResimulating.signable).toBe(false);
      expect(beforeResimulating.reason).toBe("NOT_SIMULATED");
      expect(beforeResimulating.nextCallIndex).toBe(1);

      // Resimulation is what clears it — the second half of the acceptance clause.
      const resimulated = await app.request(`/v1/actions/${id}/simulate`, { method: "POST" });

      expect(resimulated.status).toBe(200);

      const afterResimulating = await resimulated.json();

      expect(afterResimulating.signable).toBe(true);
      // Appended, not replaced: one attempt per call, both still readable.
      expect(afterResimulating.attempts).toHaveLength(2);
      expect(afterResimulating.attempts[0].callIndex).toBe(1);
      expect(afterResimulating.attempts[1].callIndex).toBe(0);

      // Call 1: the deposit.
      const afterDeposit = await submit(id, 1, `0x${"2".repeat(64)}`);
      const status = await afterDeposit.json();

      expect(afterDeposit.status).toBe(200);
      expect(status.status).toBe("submitted");
      expect(status.sentCount).toBe(2);
      expect(status.nextCallIndex).toBeNull();
      expect(await count("transaction_receipt")).toBe(2);
    });

    it("refuses to resimulate an action that has been fully sent", async () => {
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const id = prepared.action.actionId;

      await carryThrough(id, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`);

      const response = await app.request(`/v1/actions/${id}/simulate`, { method: "POST" });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("ACTION_NOT_AVAILABLE");
    });
  });

  describe("preview beside actual", () => {
    it("reports what the vault's own event said, and the difference", async () => {
      /*
       * PRD TR-F-030 and SMART-CONTRACT.md sections 4 and 5: the previewed figure is shown when the
       * action is prepared, and the actual comes from execution evidence afterwards. The two are
       * both present, and the actual never replaces the preview.
       */
      const depositHash = `0x${"2".repeat(64)}` as const;

      chain.receipts.set(depositHash, depositReceipt(depositHash, 1_000_000n, 899_950n));

      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();

      expect(prepared.action.previewed).toBe("900000");

      const status = await carryThrough(prepared.action.actionId, `0x${"1".repeat(64)}`, depositHash);

      expect(status["status"]).toBe("confirmed");
      expect(status["outcome"]).toMatchObject({
        previewed: "900000",
        actual: "899950",
        // Signed, because the vault delivered fewer shares than it previewed.
        delta: "-50",
        status: "success",
      });
    });

    it("leaves the actual null when the receipt carries no event of ours", async () => {
      /*
       * "We saw no difference" and "we saw nothing" are different claims, and only the second one
       * is true here. A zero delta would have asserted the first.
       */
      const depositHash = `0x${"2".repeat(64)}` as const;
      const receipt = depositReceipt(depositHash, 1_000_000n, 899_950n);

      chain.receipts.set(depositHash, { ...receipt, logs: [] });

      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const status = await carryThrough(prepared.action.actionId, `0x${"1".repeat(64)}`, depositHash);

      expect(status["outcome"]).toMatchObject({
        previewed: "900000",
        actual: null,
        delta: null,
      });
    });

    it("does not settle the action on the approval's receipt", async () => {
      /*
       * The approval is an ERC-20 call. Its receipt says nothing about whether the deposit
       * succeeded, and letting it set `confirmed` would report an outcome for an operation nobody
       * has observed — with `actual` null, because there is no Deposit event in it.
       */
      const approveHash = `0x${"1".repeat(64)}` as const;
      const depositHash = `0x${"2".repeat(64)}` as const;

      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const id = prepared.action.actionId;

      await carryThrough(id, approveHash, depositHash);

      // The approval's receipt turns up afterwards; the deposit's still has not.
      const receipt = depositReceipt(approveHash, 1_000_000n, 899_950n);

      chain.receipts.set(approveHash, { ...receipt, logs: [] });

      await submit(id, 0, approveHash);

      const status = await (await app.request(`/v1/actions/${id}`)).json();

      expect(status.status).toBe("submitted");
      expect(status.outcome.status).toBeNull();
    });

    it("carries no outcome while the deposit has not been mined", async () => {
      // A reported hash is not yet an outcome. TR4CE looks once and does not poll.
      const prepared = await (await app.request("/v1/actions/prepare", prepare())).json();
      const status = await carryThrough(prepared.action.actionId, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`);

      expect(status["status"]).toBe("submitted");
      expect((status["outcome"] as Record<string, unknown>)["actual"]).toBeNull();
      expect((status["outcome"] as Record<string, unknown>)["status"]).toBeNull();
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
