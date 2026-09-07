import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./openapi.js";

/**
 * Drift between the committed OpenAPI document and the schemas it is generated from.
 *
 * TECH-STACK.md section 8 forbids a handwritten copy of the contract, and this is what makes that
 * enforceable rather than aspirational: change a request shape without regenerating and CI fails
 * here, instead of a client discovering the difference at runtime.
 *
 * Regenerate with `pnpm --filter @tr4ce/api build && pnpm --filter @tr4ce/api openapi`.
 */

const committed = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json"), "utf8"),
) as Record<string, unknown>;

describe("the committed OpenAPI document", () => {
  it("matches what the schemas generate", () => {
    expect(committed).toEqual(buildOpenApiDocument());
  });

  it("declares every route the app serves", () => {
    // A route added without a document entry would ship undocumented and this check would not
    // notice, so the four paths are named rather than counted.
    expect(Object.keys(committed["paths"] as object).sort()).toEqual([
      "/v1/actions/prepare",
      "/v1/actions/{id}",
      "/v1/actions/{id}/submitted",
      "/v1/policies/evaluate",
      "/v1/reports",
      "/v1/reports/{id}",
      "/v1/vaults",
    ]);
  });

  it("uses the one error envelope everywhere a route can fail", () => {
    const document = JSON.stringify(committed);
    const failures = [...document.matchAll(/"(4\d\d|5\d\d)":\{"description/g)];

    expect(failures.length).toBeGreaterThan(0);
    // Every declared failure points at the shared envelope. A route that invented its own shape
    // would otherwise be frozen into the published contract by this very file.
    for (const response of Object.values(committed["paths"] as Record<string, never>)) {
      for (const operation of Object.values(response as Record<string, never>)) {
        for (const [code, body] of Object.entries(
          (operation as { responses: Record<string, unknown> }).responses,
        )) {
          if (!code.startsWith("4") && !code.startsWith("5")) {
            continue;
          }

          const schema = JSON.stringify(body);

          // 422 carries the evaluation response, which is a valid outcome rather than a failure:
          // an invalid draft policy is answered with its issues, not with an error envelope.
          expect(schema).toMatch(/ApiError|EvaluatePolicyResponse/);
        }
      }
    }
  });

  it("targets OpenAPI 3.1", () => {
    // z.toJSONSchema emits draft 2020-12, which 3.0 cannot express. Targeting 3.0 would require a
    // hand-translated copy of every schema — the exact thing this generation exists to avoid.
    expect(committed["openapi"]).toBe("3.1.0");
  });
});
