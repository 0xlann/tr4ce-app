import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppFromEnv } from "@tr4ce/api";

import { createMcpServer } from "./tools.js";

/**
 * The MCP entry point.
 *
 * stdio only. A streamable-HTTP transport belongs with the deployment work in Task 10; adding it
 * here would be untested configuration, because the protocol tests drive an in-memory transport and
 * would not exercise the choice either way.
 *
 * The app is built by `createAppFromEnv`, the same function the HTTP process uses, so the two
 * cannot disagree on the provider key, calculation version or block time — three values stamped
 * into stored evidence, where a disagreement would be invisible until someone compared two reports.
 *
 * That function also requires `RPC_URL_BASE`, which is what stops this server from starting without
 * a chain. Three of the six tools need one; without it the action routes answer 501 and half the
 * advertised surface would fail on use rather than at startup — the kind of failure a client
 * discovers mid-task.
 */

async function main(): Promise<void> {
  const server = createMcpServer(createAppFromEnv());

  await server.connect(new StdioServerTransport());

  // stdout is the transport. Anything written there that is not a protocol message corrupts the
  // stream, so every diagnostic goes to stderr.
  console.error("[mcp] tr4ce tools ready on stdio");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
