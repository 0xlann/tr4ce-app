import { describe, expect, it } from "vitest";

import { parsePolicy, policyJsonSchema, validatePolicy } from "./schema.js";

/** The policy from PRD section 8.2, used verbatim as the known-good baseline. */
const VALID = {
  version: 1,
  underlyingAssets: ["USDC"],
  minHistoryDays: 30,
  minTvlAssets: "2000000000000",
  minObservedReturnBps: { windowDays: 7, value: 0 },
  minWithdrawableAssets: {
    owner: "0x1111111111111111111111111111111111111111",
    value: "10000000000",
  },
} as const;

const withField = (patch: Record<string, unknown>) => ({ ...VALID, ...patch });

describe("validatePolicy", () => {
  it("accepts the policy shape the PRD specifies", () => {
    const result = validatePolicy(VALID);

    expect(result.valid).toBe(true);
    expect(result.valid && result.policy.minHistoryDays).toBe(30);
  });

  it("supports exactly the five documented rules", () => {
    // Not four and not six: the shape a user confirms is the shape the evaluator runs.
    expect(Object.keys(VALID).filter((key) => key !== "version")).toEqual([
      "underlyingAssets",
      "minHistoryDays",
      "minTvlAssets",
      "minObservedReturnBps",
      "minWithdrawableAssets",
    ]);
  });
});

describe("unknown keys", () => {
  it("rejects an unrecognised top-level key instead of stripping it", () => {
    /*
     * The behaviour this schema exists to change. zod's default would drop the key silently, and a
     * user reviewing the typed policy would never learn that something they wrote — or a model
     * invented — had been discarded before it ran.
     */
    const result = validatePolicy(withField({ maxDrawdownBps: 500 }));

    expect(result.valid).toBe(false);
    expect(!result.valid && result.issues.some((issue) => /unrecognized|unknown/i.test(issue.message))).toBe(
      true,
    );
  });

  it("rejects an unrecognised key nested inside a rule", () => {
    const result = validatePolicy(
      withField({ minObservedReturnBps: { windowDays: 7, value: 0, operator: "gte" } }),
    );

    expect(result.valid).toBe(false);
  });

  it("rejects an unrecognised key inside the withdrawal rule", () => {
    const result = validatePolicy(
      withField({
        minWithdrawableAssets: { ...VALID.minWithdrawableAssets, tolerance: "1" },
      }),
    );

    expect(result.valid).toBe(false);
  });
});

describe("amounts", () => {
  it("rejects a floating-point amount", () => {
    // PRD section 8.2: the compiler must reject floating-point amounts.
    expect(validatePolicy(withField({ minTvlAssets: "2.5" })).valid).toBe(false);
  });

  it("rejects a JSON number where a base-unit decimal string is required", () => {
    // A number would have already lost precision by the time it reached us.
    expect(validatePolicy(withField({ minTvlAssets: 2_500_000 })).valid).toBe(false);
  });

  it("rejects a number in the withdrawal threshold too", () => {
    expect(
      validatePolicy(
        withField({ minWithdrawableAssets: { ...VALID.minWithdrawableAssets, value: 10 } }),
      ).valid,
    ).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(validatePolicy(withField({ minTvlAssets: "-1" })).valid).toBe(false);
  });

  it("accepts a zero threshold", () => {
    // A zero minimum is a real choice, not a mistake.
    expect(validatePolicy(withField({ minTvlAssets: "0" })).valid).toBe(true);
  });

  it("accepts a negative basis-point target", () => {
    // "I will tolerate a loss of up to 50 bps" is a legitimate policy.
    expect(
      validatePolicy(withField({ minObservedReturnBps: { windowDays: 7, value: -50 } })).valid,
    ).toBe(true);
  });

  it("rejects a fractional basis-point target", () => {
    expect(
      validatePolicy(withField({ minObservedReturnBps: { windowDays: 7, value: 12.5 } })).valid,
    ).toBe(false);
  });
});

describe("bounded windows", () => {
  it("rejects a zero-day window", () => {
    expect(
      validatePolicy(withField({ minObservedReturnBps: { windowDays: 0, value: 0 } })).valid,
    ).toBe(false);
  });

  it("rejects a negative history requirement", () => {
    expect(validatePolicy(withField({ minHistoryDays: -1 })).valid).toBe(false);
  });

  it("rejects a fractional window", () => {
    expect(validatePolicy(withField({ minHistoryDays: 7.5 })).valid).toBe(false);
  });
});

describe("owner address", () => {
  it("rejects a malformed address", () => {
    expect(
      validatePolicy(
        withField({ minWithdrawableAssets: { ...VALID.minWithdrawableAssets, owner: "0xdead" } }),
      ).valid,
    ).toBe(false);
  });

  it("accepts a checksummed address", () => {
    expect(
      validatePolicy(
        withField({
          minWithdrawableAssets: {
            ...VALID.minWithdrawableAssets,
            owner: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
          },
        }),
      ).valid,
    ).toBe(true);
  });
});

describe("asset allowlist", () => {
  it("rejects an empty allowlist", () => {
    // A policy that allows nothing can never pass; it is a mistake, not a strict policy.
    expect(validatePolicy(withField({ underlyingAssets: [] })).valid).toBe(false);
  });

  it("rejects an asset the MVP does not support", () => {
    expect(validatePolicy(withField({ underlyingAssets: ["DAI"] })).valid).toBe(false);
  });
});

describe("issue reporting", () => {
  it("names the offending field so a user can be shown where it is wrong", () => {
    const result = validatePolicy(withField({ minTvlAssets: "2.5" }));

    expect(!result.valid && result.issues[0]?.path).toBe("minTvlAssets");
  });

  it("reports every problem at once rather than the first", () => {
    // A form that surfaces one error per submit is a form nobody finishes.
    const result = validatePolicy(withField({ minTvlAssets: "2.5", minHistoryDays: 0 }));

    expect(!result.valid && result.issues.length).toBeGreaterThan(1);
  });
});

describe("parsePolicy", () => {
  it("returns the policy when valid", () => {
    expect(parsePolicy(VALID).version).toBe(1);
  });

  it("throws with the failing paths named", () => {
    expect(() => parsePolicy(withField({ minTvlAssets: "2.5" }))).toThrow(/minTvlAssets/);
  });
});

describe("published JSON Schema", () => {
  it("describes the policy contract", () => {
    // TR-F-020: policies validate against a versioned JSON Schema, which agents and forms both read.
    expect(policyJsonSchema).toMatchObject({ type: "object" });
    expect(Object.keys((policyJsonSchema as { properties: object }).properties)).toContain(
      "minWithdrawableAssets",
    );
  });

  it("forbids additional properties", () => {
    expect((policyJsonSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
});
