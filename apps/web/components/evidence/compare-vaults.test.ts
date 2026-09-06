import { expect, it } from "vitest";

import { getVaultSummaries } from "../../src/demo/fixtures.js";
import { compareVaults } from "./compare-vaults.js";

it("never ranks UNKNOWN above PASS", () => {
  const order = compareVaults(getVaultSummaries("balanced")).map((vault) => vault.report.policy.status);

  expect(order.indexOf("PASS")).toBeLessThan(order.indexOf("UNKNOWN"));
});
