import { policyV1Schema, type PolicyV1 } from "@tr4ce/domain";

/**
 * The policy draft, and the pure functions over it.
 *
 * Kept apart from the component so it can be tested without rendering: what a draft becomes on the
 * wire, and where the evaluator's issues belong, are both decisions that fail silently. A wrong
 * issue path leaves a panel that looks correct and shows nothing.
 */

export type PolicyDraft = {
  minHistoryDays: string;
  minTvlAssets: string;
  returnWindowDays: string;
  minObservedReturnBps: string;
  owner: string;
  minWithdrawableAssets: string;
};

export const presets: Record<"strict" | "balanced" | "lenient", PolicyDraft> = {
  strict: {
    minHistoryDays: "30",
    minTvlAssets: "5000000000000",
    returnWindowDays: "7",
    minObservedReturnBps: "100",
    owner: "0x0000000000000000000000000000000000000000",
    minWithdrawableAssets: "25000000000",
  },
  balanced: {
    minHistoryDays: "30",
    minTvlAssets: "2000000000000",
    returnWindowDays: "7",
    minObservedReturnBps: "0",
    owner: "0x0000000000000000000000000000000000000000",
    minWithdrawableAssets: "10000000000",
  },
  lenient: {
    minHistoryDays: "14",
    minTvlAssets: "1000000000000",
    returnWindowDays: "7",
    minObservedReturnBps: "-50",
    owner: "0x0000000000000000000000000000000000000000",
    minWithdrawableAssets: "5000000000",
  },
};

/**
 * A draft, shaped as a policy but not asserted to be one.
 *
 * Returns `unknown` on purpose. Every field here is a string typed by a person, and coercing a
 * malformed one into a number would turn "this is wrong" into a plausible wrong answer. The API
 * decides, and it is built to answer with issues.
 */
export function draftToPolicy(draft: PolicyDraft): unknown {
  return {
    version: 1,
    underlyingAssets: ["USDC"],
    minHistoryDays: numberOrRaw(draft.minHistoryDays),
    minTvlAssets: draft.minTvlAssets,
    minObservedReturnBps: {
      windowDays: numberOrRaw(draft.returnWindowDays),
      value: numberOrRaw(draft.minObservedReturnBps),
    },
    minWithdrawableAssets: { owner: draft.owner, value: draft.minWithdrawableAssets },
  };
}

/** True when the draft happens to be a valid policy — used only to preview formatted amounts. */
export function asPolicy(draft: PolicyDraft): PolicyV1 | null {
  const parsed = policyV1Schema.safeParse(draftToPolicy(draft));

  return parsed.success ? parsed.data : null;
}

/**
 * Where a field's issues land in the policy the evaluator parsed, so they can be shown beside it.
 *
 * The paths are relative to the policy object rather than to the request that carried it —
 * `minObservedReturnBps.windowDays`, not `policy.minObservedReturnBps.windowDays`. Verified against
 * a live response: the first version prefixed everything with `policy.`, so no issue ever matched a
 * field and the panel silently showed none while looking perfectly correct.
 */
export function pathFor(key: keyof PolicyDraft): string {
  switch (key) {
    case "returnWindowDays":
      return "minObservedReturnBps.windowDays";
    case "minObservedReturnBps":
      return "minObservedReturnBps.value";
    case "owner":
      return "minWithdrawableAssets.owner";
    case "minWithdrawableAssets":
      return "minWithdrawableAssets.value";
    default:
      return key;
  }
}

/**
 * A number when the text is one, the raw text when it is not.
 *
 * The evaluator's issue list is what tells the user their entry was wrong. Passing `NaN` would
 * produce a less useful message than passing what they actually typed.
 */
function numberOrRaw(value: string): number | string {
  const trimmed = value.trim();

  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : value;
}
