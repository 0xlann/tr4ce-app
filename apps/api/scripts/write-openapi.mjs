/**
 * Write the generated OpenAPI document to apps/api/openapi.json.
 *
 * The file is committed so a reader can see the published contract without running anything, and
 * `openapi.drift.test.ts` regenerates it and fails on any difference. Never edit it by hand.
 *
 *   pnpm --filter @tr4ce/api build && node scripts/write-openapi.mjs
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "../dist/openapi.js";

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");

writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${target}`);
