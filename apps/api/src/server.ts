import { serve } from "@hono/node-server";

import { createAppFromEnv, type App } from "./index.js";

/**
 * The Node entry point.
 *
 * A separate process from the Next.js app on purpose (TECH-STACK.md section 3): the MCP server and
 * the workers need the same typed service without importing UI route handlers.
 *
 * The wiring itself lives in `createAppFromEnv` so this process and the MCP server cannot drift on
 * the provider key, calculation version, or block time.
 */

const port = Number(process.env["PORT"] ?? "8787");

const app: App = start();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

function start(): App {
  try {
    return createAppFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
