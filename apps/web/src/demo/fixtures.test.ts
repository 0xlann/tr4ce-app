import { describe, expect, it } from "vitest";

import { getPolicyPreset, getVaultSummaries } from "./fixtures.js";

describe("illustrative policy fixtures", () => {
  it("orders PASS before FAIL before UNKNOWN for the balanced policy", () => {
    expect(getVaultSummaries("balanced").map((vault) => vault.report.policy.status)).toEqual([
      "PASS",
      "FAIL",
      "UNKNOWN",
    ]);
  });

  it("changes the policy threshold without fabricating a policy pass", () => {
    const strict = getPolicyPreset("strict");
    const lenient = getPolicyPreset("lenient");

    expect(strict.minTvlAssets).not.toBe(lenient.minTvlAssets);
    expect(getVaultSummaries("strict").some((vault) => vault.report.policy.status === "UNKNOWN")).toBe(true);
  });
});
