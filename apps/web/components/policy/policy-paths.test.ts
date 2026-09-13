import { describe, expect, it } from "vitest";

import { pathFor } from "./policy-draft.js";

/**
 * The issue paths the evaluator actually returns, taken from a live response rather than guessed:
 *
 *   minHistoryDays
 *   minObservedReturnBps.windowDays
 *   minObservedReturnBps.value
 *   minWithdrawableAssets.owner
 *
 * The first version of this mapping prefixed every path with `policy.`, so no issue ever matched a
 * field and the panel silently showed none. It looked correct in every screenshot.
 */

describe("pathFor", () => {
  it("uses the evaluator's own paths, relative to the policy", () => {
    expect(pathFor("minHistoryDays")).toBe("minHistoryDays");
    expect(pathFor("minTvlAssets")).toBe("minTvlAssets");
    expect(pathFor("returnWindowDays")).toBe("minObservedReturnBps.windowDays");
    expect(pathFor("minObservedReturnBps")).toBe("minObservedReturnBps.value");
    expect(pathFor("owner")).toBe("minWithdrawableAssets.owner");
    expect(pathFor("minWithdrawableAssets")).toBe("minWithdrawableAssets.value");
  });

  it("never prefixes a path with the request field that carried the policy", () => {
    // The bug, as an assertion. `policy.minHistoryDays` is what the request looks like from outside;
    // it is not what the evaluator reports.
    for (const key of ["minHistoryDays", "minTvlAssets", "returnWindowDays", "owner"] as const) {
      expect(pathFor(key)).not.toMatch(/^policy\./);
    }
  });

  it("keeps the two return fields distinguishable", () => {
    // One is a prefix of the other, which is why the panel matches exactly rather than by prefix.
    expect(pathFor("minObservedReturnBps")).not.toBe(pathFor("returnWindowDays"));
  });
});
