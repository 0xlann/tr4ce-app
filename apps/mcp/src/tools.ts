import {
  createReportRequestSchema,
  evaluatePolicyRequestSchema,
  evaluatePolicyResponseSchema,
  prepareActionRequestSchema,
  preparedActionResponseSchema,
  reportResponseSchema,
  vaultListResponseSchema,
  actionStatusResponseSchema,
  type App,
} from "@tr4ce/api";
import { chainIdSchema } from "@tr4ce/domain";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * The six agent tools (PRD TR-F-041, INTEGRATIONS.md section 7).
 *
 * Every tool dispatches into the same Hono app the HTTP API serves, in process. Nothing here
 * calculates anything: the evidence engine, the policy evaluator and the calldata builder are
 * reached through the routes that already parse their input and serialise their output through the
 * domain schemas. That is what makes "MCP and UI return the same report schema" (PRD section 13,
 * step 7) structural rather than a promise — there is no second implementation to drift.
 *
 * **On "side effect: None" in the integrations table.** It cannot mean "writes nothing":
 * `prepare_deposit` persists a prepared action and its simulation, and `get_evidence` persists a
 * report. It means what the acceptance clause means — no chain state changes and no funds move.
 * TR4CE never submits a transaction, and there is no tool here that could. These tools are
 * therefore *not* read-only, and nothing in this file or in SKILL.md calls them that.
 */

/** Exactly the six names, in the order the integrations table lists them. */
export const TOOL_NAMES = [
  "search_vaults",
  "get_evidence",
  "evaluate_policy",
  "prepare_deposit",
  "prepare_redeem",
  "get_action_status",
] as const;

const searchVaultsInput = z.strictObject({
  /** Optional rather than defaulted here: the route already defaults to Base, in one place. */
  chainId: chainIdSchema.optional(),
});

const actionStatusInput = z.strictObject({
  actionId: z.string().regex(/^act_[0-9a-f]{32}$/, "Expected a TR4CE action identifier"),
});

/**
 * The prepare input, minus the operation.
 *
 * Omitted rather than left in and ignored: `prepareActionRequestSchema` is a `z.strictObject`, so a
 * client that took the advertised schema at its word and sent `operation` would be rejected by the
 * route. The tool name carries it instead, and it is added back below.
 */
const prepareInput = prepareActionRequestSchema.omit({ operation: true });

/**
 * A server with the six tools registered against one app.
 *
 * Takes the app rather than building it, so the protocol tests can drive the same registration over
 * an in-memory transport with a fixture chain behind it.
 */
export function createMcpServer(app: App): McpServer {
  const server = new McpServer(
    { name: "tr4ce", version: "0.1.0" },
    {
      instructions:
        "TR4CE returns reproducible evidence about ERC-4626 vaults and prepares unsigned transactions. It never signs and never submits: every call it builds must be approved in the user's own wallet. Amounts are integer base units as decimal strings. UNKNOWN is not FAIL.",
    },
  );

  registerTools(server, app);

  return server;
}

export function registerTools(server: McpServer, app: App): void {
  server.registerTool(
    "search_vaults",
    {
      title: "Search vaults",
      description:
        "List the ERC-4626 vaults TR4CE has verified on a chain, with the asset each holds, its share decimals, and which capability adapter interprets its reads. Start here: every other tool takes a vault address this returns.",
      inputSchema: searchVaultsInput,
      outputSchema: vaultListResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      respond(
        await app.request(
          args.chainId === undefined ? "/v1/vaults" : `/v1/vaults?chainId=${args.chainId}`,
        ),
      ),
  );

  server.registerTool(
    "get_evidence",
    {
      title: "Get evidence",
      description:
        "Produce the immutable evidence report for a vault over a window, and evaluate a typed policy against it. Amounts are integer base units as decimal strings, never floats. The report states the elapsed time it actually measured, which may be shorter than the window requested. Asking twice with the same inputs returns the same report: the identifier is derived from the observations.",
      inputSchema: createReportRequestSchema,
      outputSchema: reportResponseSchema,
      // Not read-only: a report is persisted. Idempotent, because its id is derived from the
      // observations it cites, so repeating the request cannot produce a second one.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => respond(await app.request("/v1/reports", post(args))),
  );

  server.registerTool(
    "evaluate_policy",
    {
      title: "Evaluate policy",
      description:
        "Check a candidate policy against a vault's current evidence without storing anything. Returns a per-rule verdict of PASS, FAIL or UNKNOWN with the evidence each rule used. UNKNOWN means the observation needed was not available, which is not the same as FAIL and must not be reported as one. An invalid policy comes back as issues rather than an error.",
      inputSchema: evaluatePolicyRequestSchema,
      outputSchema: evaluatePolicyResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => respond(await app.request("/v1/policies/evaluate", post(args))),
  );

  server.registerTool(
    "prepare_deposit",
    {
      title: "Prepare deposit",
      description:
        "Build the unsigned calls for a deposit and simulate the first one against a pinned block. Returns an exact approval followed by the deposit when the owner's allowance falls short, and the deposit alone when it does not. TR4CE never requests an unlimited allowance, never signs, and never submits: the wallet owner must approve every call. The simulation expires after 3 blocks or 60 seconds, whichever comes first.",
      inputSchema: prepareInput,
      outputSchema: preparedActionResponseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      respond(await app.request("/v1/actions/prepare", post({ ...args, operation: "deposit" }))),
  );

  server.registerTool(
    "prepare_redeem",
    {
      title: "Prepare redeem",
      description:
        "Build the unsigned call for a redemption and simulate it against a pinned block. The amount is in shares, not assets. A vault's maxRedeem can sit fractionally below the owner's own share balance, so a request built from balanceOf may be refused; use the limit the report reports. TR4CE never signs and never submits.",
      inputSchema: prepareInput,
      outputSchema: preparedActionResponseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      respond(await app.request("/v1/actions/prepare", post({ ...args, operation: "redeem" }))),
  );

  server.registerTool(
    "get_action_status",
    {
      title: "Get action status",
      description:
        "Report whether a prepared action may still be signed, judged against the chain now rather than when it was prepared, along with which call is next and what the receipt said once the wallet reported a hash. A false `signable` names its reason: the simulation failed, the next call has not been simulated, or one of the two expiry budgets is spent.",
      inputSchema: actionStatusInput,
      outputSchema: actionStatusResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => respond(await app.request(`/v1/actions/${args.actionId}`)),
  );
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Turn an HTTP response into a tool result.
 *
 * The body text is passed through untouched rather than parsed and re-serialised. For the shapes
 * this contract carries the two happen to produce identical bytes — every large number is already a
 * decimal string, and no key is integer-like — so this is not a bug being avoided. It is a
 * dependency being avoided: pass-through is byte-identical to the HTTP surface for *any* payload,
 * where a round trip is only identical for the ones we happen to send today.
 *
 * `tools.protocol.test.ts` checks that equality. It catches reshaping and reformatting, and it does
 * not distinguish a round trip from a pass-through — because on this contract there is nothing to
 * distinguish.
 *
 * A failure comes back as `isError` carrying the same structured envelope every route uses
 * (PRD TR-F-040), with no `structuredContent`: the declared output schema describes the success
 * shape, and widening it to a union would leave a client unable to tell which it received.
 */
async function respond(response: Response): Promise<CallToolResult> {
  const text = await response.text();

  if (!response.ok) {
    return { isError: true, content: [{ type: "text", text }] };
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}
