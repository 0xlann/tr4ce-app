import { serve } from "@hono/node-server";
import { createChainClient } from "@tr4ce/chain";
import { createDatabase } from "@tr4ce/db";

import { createApp } from "./app.js";
import { actionChainFrom, chainTimeFrom } from "./services/evidence-service.js";

/**
 * The Node entry point.
 *
 * A separate process from the Next.js app on purpose (TECH-STACK.md section 3): the MCP server and
 * the workers need the same typed service without importing UI route handlers.
 */

const databaseUrl = required("DATABASE_URL");
const rpcUrl = required("RPC_URL_BASE");
const port = Number(process.env["PORT"] ?? "8787");

const { db } = createDatabase(databaseUrl);
const chainClient = createChainClient(rpcUrl);

const app = createApp({
  db,
  chain: chainTimeFrom(chainClient),
  actionChain: actionChainFrom(chainClient),
  providerKey: process.env["TR4CE_RPC_PROVIDER_KEY"] ?? "base-alchemy-mainnet",
  calculationVersion: process.env["TR4CE_CALCULATION_VERSION"] ?? "1.0.0",
  streamKey: process.env["TR4CE_STREAM_KEY"] ?? "erc4626-promotion",
  // Base targets two-second blocks. Used only to estimate where a requested window opens; the
  // report states the elapsed time it actually measured.
  blockSeconds: 2,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    console.error(`${name} is required.`);
    process.exit(1);
  }

  return value;
}
