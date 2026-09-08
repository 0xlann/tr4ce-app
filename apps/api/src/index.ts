import { createChainClient } from "@tr4ce/chain";
import { createDatabase, type Database } from "@tr4ce/db";

import { createApp, type App } from "./app.js";
import { actionChainFrom, chainTimeFrom } from "./services/evidence-service.js";

/**
 * The importable surface of the API.
 *
 * `apps/api` is an app that is also a library, which is a compromise worth naming. TECH-STACK.md
 * section 3 says the MCP server "needs the same typed service without importing UI route handlers",
 * and the services are only half of what it needs: `POST /v1/policies/evaluate` orchestrates
 * `validatePolicy` → `requireVault` → `buildDraft` → `evaluatePolicy` inside its handler, and the
 * structured-error envelope is applied by `app.onError`. An MCP server calling the services one by
 * one would have to reimplement both, which is the duplication this is meant to avoid.
 *
 * So the MCP server dispatches into this Hono app in process. The alternative — lifting the
 * services and the route orchestration into a package of their own — is the tidier shape and can be
 * done later; it would not change a line of what the tools do.
 */

export { createApp, type App, type AppOptions } from "./app.js";
export { ApiFailure } from "./errors.js";
export * from "./contract.js";
export { buildOpenApiDocument } from "./openapi.js";

export interface AppFromEnvOptions {
  /** Overridden by tests and by callers that already hold a pool. */
  db?: Database;
}

/**
 * Build the app the way a deployment does, from the environment.
 *
 * Shared by the HTTP entry point and the MCP server so the two cannot drift apart on the provider
 * key, the calculation version, or the block time — three values that are stamped into stored
 * evidence and would be invisible if the two processes disagreed.
 */
export function createAppFromEnv(options: AppFromEnvOptions = {}): App {
  const databaseUrl = required("DATABASE_URL");
  const rpcUrl = required("RPC_URL_BASE");

  const db = options.db ?? createDatabase(databaseUrl).db;
  const chainClient = createChainClient(rpcUrl);

  return createApp({
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
}

/**
 * An environment variable, or a refusal to start.
 *
 * Throws rather than calling `process.exit`, so a caller that is not a process entry point — the
 * MCP server under test, for instance — can report the problem instead of taking the runtime down.
 */
export function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }

  return value;
}
