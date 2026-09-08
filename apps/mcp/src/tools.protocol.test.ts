import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type ActionChain, type App, type PrepareOutcome } from "@tr4ce/api";
import type { PreparedCall, SimulationResult } from "@tr4ce/chain";
import {
  createDatabase,
  migrate,
  provisionTestDatabase,
  seedRegistry,
  vaultId as deriveVaultId,
  vaultFlowId,
  vaultSnapshotId,
  writeApplicationCursor,
  type Database,
} from "@tr4ce/db";
import { apiErrorSchema, type PolicyV1 } from "@tr4ce/domain";
import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { sql } from "drizzle-orm";
import { encodeFunctionData, keccak256 } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer, TOOL_NAMES } from "./tools.js";

/**
 * The six tools, driven through a real MCP client over an in-memory transport.
 *
 * Calling `registerTools` and inspecting the result would test the registration; this tests the
 * protocol — discovery, argument validation, result shape, error signalling — which is the surface
 * an agent actually meets. The acceptance clause is about what an MCP client can do.
 *
 * Gated on TR4CE_TEST_DATABASE_URL, like every other integration suite here.
 */

const url = process.env["TR4CE_TEST_DATABASE_URL"];
const here = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = 8453;
const SCHEMA_VERSION = "1.0.0";
const STREAM_KEY = "erc4626-mcp-test";
const NOW = new Date("2026-09-08T00:00:00.000Z");
const BLOCK = 50_879_900n;

const WINDOW_START = Math.min(
  ...baseUsdcVaultManifest.vaults.map((entry) => Number(entry.windowStartBlock)),
);
const START_BLOCK = WINDOW_START;
// Roughly seven days of Base blocks after the start, so a seven-day window reaches back to it.
const END_BLOCK = WINDOW_START + 302_400;

const hash = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;

const VAULT = baseUsdcVaultManifest.vaults[0]!.address.toLowerCase();
const USDC = baseUsdcVaultManifest.canonicalAssets[0]!.address.toLowerCase();
const OWNER = "0x00000000000000000000000000000000000000aa";

const POLICY: PolicyV1 = {
  version: 1,
  underlyingAssets: ["USDC"],
  minHistoryDays: 7,
  minTvlAssets: "1000000",
  minObservedReturnBps: { windowDays: 7, value: 10 },
  minWithdrawableAssets: { owner: OWNER, value: "1000000" },
};

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

/**
 * A chain that answers what the action routes ask.
 *
 * The chain behaviour itself is proven against a writable Anvil fork in @tr4ce/chain. What these
 * tests are about is the protocol surface, and a fixture keeps them about that.
 */
function fixtureActionChain(): ActionChain {
  const calls: PreparedCall[] = [
    {
      chainId: CHAIN_ID,
      to: USDC as `0x${string}`,
      data: encodeFunctionData({
        abi: erc20,
        functionName: "approve",
        args: [VAULT as `0x${string}`, 1_000_000n],
      }),
      value: "0",
      kind: "approve",
    },
    { chainId: CHAIN_ID, to: VAULT as `0x${string}`, data: "0x6e553f65", value: "0", kind: "deposit" },
  ];

  const outcome: PrepareOutcome = { ok: true, calls, previewed: 900_000n };

  return {
    async prepareDeposit() {
      return outcome;
    },
    async prepareRedeem() {
      return outcome;
    },
    async currentBlock() {
      return {
        number: BLOCK,
        hash: `0x${"a".repeat(64)}` as `0x${string}`,
        timestamp: Math.floor(NOW.getTime() / 1000),
      };
    },
    async simulate(input): Promise<SimulationResult> {
      return {
        status: "SUCCEEDED",
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
        gasEstimate: 182_000n,
        revertData: null,
        message: null,
        expiresAtBlock: input.blockNumber + 3n,
        expiresAt: new Date((input.blockTimestamp + 60) * 1000).toISOString(),
      };
    },
    async receipt() {
      // Not mined. TR4CE looks once and never polls.
      return null;
    },
  };
}

describe.skipIf(url === undefined)("the tr4ce MCP surface", () => {
  let handle: { db: Database; close: () => Promise<void> };
  let db: Database;
  let app: App;
  let client: Client;

  beforeAll(async () => {
    const databaseUrl = await provisionTestDatabase(url!, "mcp");

    handle = createDatabase(databaseUrl, { max: 4 });
    db = handle.db;

    await db.execute(
      sql.raw(
        readFileSync(
          join(here, "..", "..", "..", "substreams", "erc4626", "schema.sql"),
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
    await client?.close();
    await handle?.close();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE transaction_receipt, simulation, prepared_action,
                   rule_result, report_observation, evidence_report, rpc_observation,
                   policy_rule, policy_version, policy, wallet,
                   vault_flow, vault_snapshot, indexer_cursor`,
    );

    await seedObservations();

    app = createApp({
      db,
      chain: { blockTimestamp: async () => "2026-01-01T00:00:00.000Z" },
      actionChain: fixtureActionChain(),
      providerKey: "fixture",
      calculationVersion: "1.0.0",
      streamKey: STREAM_KEY,
      blockSeconds: 2,
      now: () => NOW,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test", version: "0.0.0" });

    await Promise.all([
      createMcpServer(app).connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  const text = (result: unknown) => {
    const content = (result as CallToolResult).content;

    return content.map((block) => (block.type === "text" ? block.text : "")).join("");
  };

  const evidenceArgs = { chainId: CHAIN_ID, vaultAddress: VAULT, windowDays: 7, policy: POLICY };

  // ---------------------------------------------------------------------------------------------

  describe("discovery", () => {
    it("registers exactly the six tools the specification names", async () => {
      /*
       * Exactly, not "at least". A seventh tool is how an unreviewed capability reaches an agent,
       * and TR-F-041 lists six by name.
       */
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    });

    it("offers nothing that submits, signs, or executes", async () => {
      // The acceptance clause: "without unrestricted GraphQL or transaction submission." Checked
      // against what a client is actually told exists, names and prose alike.
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.name).not.toMatch(/submit|send|sign|execute|transfer|approve_/i);
      }

      const advertised = JSON.stringify(tools);

      expect(advertised).not.toMatch(/\bgraphql\b/i);
      expect(advertised).not.toMatch(/private key|privateKey|mnemonic/i);
    });

    it("declares an output schema for every tool", async () => {
      // Without one the SDK cannot validate `structuredContent`, and an agent has nothing to parse
      // against but prose.
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.outputSchema, `${tool.name} has no output schema`).toBeDefined();
      }
    });

    it("does not advertise `operation` on the prepare tools", async () => {
      /*
       * `prepareActionRequestSchema` is a strict object, so a client that took the advertised schema
       * at its word and sent `operation` would be rejected by the route it never saw. The tool name
       * carries the operation instead.
       */
      const { tools } = await client.listTools();

      for (const name of ["prepare_deposit", "prepare_redeem"]) {
        const tool = tools.find((candidate) => candidate.name === name)!;
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;

        expect(Object.keys(properties ?? {})).not.toContain("operation");
      }
    });
  });

  describe("search_vaults", () => {
    it("returns the registry the HTTP surface returns", async () => {
      const result = await client.callTool({ name: "search_vaults", arguments: {} });
      const expected = await (await app.request("/v1/vaults")).text();

      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe(expected);
    });
  });

  describe("get_evidence", () => {
    it("returns byte-for-byte what the HTTP surface stored", async () => {
      /*
       * The checklist item: "Test HTTP report JSON and MCP report JSON for canonical equality."
       *
       * Byte equality, not deep equality. The two are different claims — a re-serialised object can
       * carry the same values in a different key order and pass a deep comparison while being a
       * different document to anything that hashes or diffs it. This is the assertion that carries
       * the claim; the structured comparison below is a second, weaker check.
       */
      const created = await (await app.request("/v1/reports", post(evidenceArgs))).json();
      const reportId = created.report.reportId;

      const overHttp = await (await app.request(`/v1/reports/${reportId}`)).text();
      const overMcp = await client.callTool({ name: "get_evidence", arguments: evidenceArgs });

      expect(text(overMcp)).toBe(overHttp);
      expect(overMcp.structuredContent).toEqual(JSON.parse(overHttp));
    });

    it("names the same report when asked twice, and says which time made it", async () => {
      /*
       * The identifier is derived from the observations, so an agent that asks again gets the same
       * report rather than a second one to choose between.
       *
       * The envelopes are not identical, and should not be: `created` flips. That flag is how a
       * client tells "I made this" from "this already existed", and a tool that reported `true`
       * both times would be claiming to have produced evidence it merely read.
       */
      const first = JSON.parse(
        text(await client.callTool({ name: "get_evidence", arguments: evidenceArgs })),
      );
      const second = JSON.parse(
        text(await client.callTool({ name: "get_evidence", arguments: evidenceArgs })),
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.report).toEqual(first.report);
      expect(second.report.reportId).toBe(first.report.reportId);
    });
  });

  describe("evaluate_policy", () => {
    it("validates a real evaluation against its declared output schema", async () => {
      /*
       * The success path, which nothing else reaches.
       *
       * The SDK skips output-schema validation on error results, so a tool whose only test sends an
       * invalid policy has never had its `outputSchema` checked against real structured content.
       * `evaluatePolicyResponseSchema` nests `policyEvaluationSchema`, which no other tool here
       * pushes through the SDK's validator — if it does not round-trip, this tool throws on every
       * successful use and passes on every failed one.
       */
      const result = await client.callTool({
        name: "evaluate_policy",
        arguments: { chainId: CHAIN_ID, vaultAddress: VAULT, windowDays: 7, policy: POLICY },
      });

      expect(result.isError).toBeFalsy();

      const body = JSON.parse(text(result));

      expect(body.evaluation).not.toBeNull();
      expect(body.issues).toEqual([]);
      expect(body.asOfBlock).toEqual(expect.any(String));
      // Reaching here at all means the SDK validated structuredContent against the declared schema.
      expect(result.structuredContent).toEqual(body);
      expect(body.evaluation.rules.length).toBeGreaterThan(0);
    });

    it("answers an invalid policy with issues rather than an error", async () => {
      // TR-F-024: this tool exists so a caller can be shown what is wrong with a draft.
      const result = await client.callTool({
        name: "evaluate_policy",
        arguments: { chainId: CHAIN_ID, vaultAddress: VAULT, windowDays: 7, policy: { version: 1 } },
      });

      const body = JSON.parse(text(result));

      expect(body.evaluation).toBeNull();
      expect(body.issues.length).toBeGreaterThan(0);
    });
  });

  describe("prepare_deposit", () => {
    it("returns unsigned calls and nothing resembling a signature", async () => {
      const result = await client.callTool({
        name: "prepare_deposit",
        arguments: {
          chainId: CHAIN_ID,
          vaultAddress: VAULT,
          owner: OWNER,
          receiver: OWNER,
          amount: "1000000",
        },
      });

      const payload = text(result);
      const body = JSON.parse(payload);

      expect(result.isError).toBeFalsy();
      expect(body.action.transactions.length).toBeGreaterThanOrEqual(1);
      expect(body.action.transactions[0].data).toMatch(/^0x[0-9a-f]*$/i);

      // ERD section 7 in four words: "No signature is stored." Checked on the wire, because a
      // response is what a client actually sees.
      for (const forbidden of ["signature", "signed", "privateKey", "rawTransaction", '"v":', '"r":', '"s":']) {
        expect(payload).not.toContain(forbidden);
      }
    });

    it("is refused when the caller sends the operation the tool name already carries", async () => {
      const result = await client.callTool({
        name: "prepare_deposit",
        arguments: {
          chainId: CHAIN_ID,
          vaultAddress: VAULT,
          owner: OWNER,
          receiver: OWNER,
          amount: "1000000",
          operation: "redeem",
        },
      });

      // Caught by the tool's own input schema, before the route: a client cannot talk the deposit
      // tool into preparing a redemption.
      expect(result.isError).toBe(true);
    });
  });

  describe("get_action_status", () => {
    it("reports an unknown action through the shared error envelope", async () => {
      /*
       * TR-F-040: structured errors. An MCP failure that carried a bare string would leave an agent
       * guessing, and the envelope is the same one every HTTP route answers with.
       */
      const result = await client.callTool({
        name: "get_action_status",
        arguments: { actionId: `act_${"0".repeat(32)}` },
      });

      expect(result.isError).toBe(true);
      // Parsed, not pattern-matched: this asserts the shape, not that the words look right.
      expect(apiErrorSchema.parse(JSON.parse(text(result))).error.code).toBe("ACTION_NOT_FOUND");
      // An error result carries no structured content: the declared output schema is the success
      // shape, and a union would leave a client unable to tell which it received.
      expect(result.structuredContent).toBeUndefined();
    });

    it("follows a prepared action to the call awaiting signature", async () => {
      const prepared = JSON.parse(
        text(
          await client.callTool({
            name: "prepare_deposit",
            arguments: {
              chainId: CHAIN_ID,
              vaultAddress: VAULT,
              owner: OWNER,
              receiver: OWNER,
              amount: "1000000",
            },
          }),
        ),
      );

      const status = await client.callTool({
        name: "get_action_status",
        arguments: { actionId: prepared.action.actionId },
      });

      const body = JSON.parse(text(status));

      expect(body.signable).toBe(true);
      expect(body.nextCallIndex).toBe(0);
    });
  });

  /*
   * Promoted rows, written directly. Promotion itself is @tr4ce/db's suite, and every number a
   * report carries comes from here rather than from a provider.
   */
  async function seedObservations(): Promise<void> {
    const vaultRowId = deriveVaultId(CHAIN_ID, VAULT);
    const capabilityId = (
      await db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM vault_capability WHERE vault_id = ${vaultRowId} LIMIT 1`,
      )
    )[0]!.id;

    for (const [index, block] of [START_BLOCK, END_BLOCK].entries()) {
      const blockHash = hash(String(index + 1));
      const oneShareAssets = index === 0 ? "1000000" : "1010000";

      await db.execute(sql`
        INSERT INTO vault_snapshot (
          id, vault_id, capability_id, chain_id, block_number, block_hash, block_time,
          total_assets, total_supply, one_share_units, one_share_assets, call_status, call_errors,
          trigger_activity, trigger_checkpoint, trigger_anchor, canonical, schema_version
        ) VALUES (
          ${vaultSnapshotId(CHAIN_ID, VAULT, blockHash, SCHEMA_VERSION)}::uuid, ${vaultRowId}::uuid,
          ${capabilityId}::uuid, ${CHAIN_ID}, ${String(block)}::numeric,
          decode(${blockHash.slice(2)}, 'hex'),
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
        decode(${OWNER.slice(2)}, 'hex'), '5000000'::numeric, '4950000'::numeric, true,
        ${SCHEMA_VERSION}
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
});

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
