import type { PolicyRuleKey, PolicyRuleResult, PolicyV1 } from "@tr4ce/domain";
import type { EvidenceReportDraft } from "@tr4ce/evidence";
import { describe, expect, it } from "vitest";

import { evaluatePolicy, overallStatus, type EvaluationInput } from "./evaluate.js";
import { parsePolicy } from "./schema.js";

const OWNER = "0x1111111111111111111111111111111111111111";

const policy = (overrides: Partial<PolicyV1> = {}): PolicyV1 =>
  parsePolicy({
    version: 1,
    underlyingAssets: ["USDC"],
    minHistoryDays: 7,
    minTvlAssets: "2000000000000",
    minObservedReturnBps: { windowDays: 7, value: 0 },
    minWithdrawableAssets: { owner: OWNER, value: "10000000000" },
    ...overrides,
  });

/**
 * A draft that satisfies every rule, so each test can break exactly one thing and see only that
 * rule move.
 */
const draft = (overrides: Partial<EvidenceReportDraft> = {}): EvidenceReportDraft =>
  ({
    schemaVersion: "1.0.0",
    reportId: "trc_test",
    calculationVersion: "1.0.0",
    vault: {
      chainId: 8453,
      address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetSymbol: "USDC",
    },
    asOf: {
      blockNumber: "50879897",
      blockHash: `0x${"1".repeat(64)}`,
      timestamp: "2026-09-04T12:00:00.000Z",
    },
    generatedAt: "2026-09-05T00:00:00.000Z",
    observations: {
      shareValue: {
        oneShareBaseUnits: "1000000000000000000",
        assetsNow: "1052300",
        assetsAtStart: "1041000",
        windowDays: 7,
        returnBps: 108,
        numerator: 113n,
        denominator: 10_410n,
        rounding: "floor",
      },
      totalAssets: "4200000000000",
      netFlowAssets: "0",
      maxWithdrawAssets: "50000000000",
    },
    flows: {
      depositedAssets: 0n,
      withdrawnAssets: 0n,
      netFlowAssets: 0n,
      depositCount: 0,
      withdrawalCount: 0,
      excluded: { mints: 0, burns: 0, transfers: 0, nonCanonical: 0, missingAssets: 0 },
    },
    elapsedSeconds: 7 * 86_400,
    reasonCodes: [],
    provenance: [],
    limitations: [],
    ...overrides,
  }) as EvidenceReportDraft;

const input = (overrides: Partial<EvaluationInput> = {}): EvaluationInput => ({
  policy: policy(),
  draft: draft(),
  assetIdentity: { canonicalKey: "USDC" },
  // Deployed well before the window, so history failures are about our data, not the vault's age.
  vaultDeployedAt: "2025-01-01T00:00:00.000Z",
  observedOwner: OWNER,
  ...overrides,
});

const ruleFor = (result: { rules: PolicyRuleResult[] }, key: PolicyRuleKey): PolicyRuleResult =>
  result.rules.find((rule) => rule.key === key)!;

describe("a fully satisfied policy", () => {
  it("passes every rule", () => {
    const result = evaluatePolicy(input());

    expect(result.status).toBe("PASS");
    expect(result.rules).toHaveLength(5);
    expect(result.rules.every((rule) => rule.status === "PASS")).toBe(true);
  });

  it("reports each rule's threshold, observed value and evidence", () => {
    // TR-F-021: status, observed value, threshold, evidence references and reason codes, every time.
    for (const rule of evaluatePolicy(input()).rules) {
      expect(rule.threshold).not.toBe("");
      expect(rule.observedValue).not.toBeNull();
      expect(rule.evidenceReferences.length).toBeGreaterThan(0);
    }
  });
});

describe("truth table", () => {
  it("lets one FAIL beat four PASSes", () => {
    const result = evaluatePolicy(
      input({ draft: draft({ observations: { ...draft().observations, totalAssets: "1" } }) }),
    );

    expect(ruleFor(result, "minimumTvl").status).toBe("FAIL");
    expect(result.status).toBe("FAIL");
  });

  it("lets one UNKNOWN beat four PASSes", () => {
    const result = evaluatePolicy(input({ assetIdentity: null }));

    expect(ruleFor(result, "underlyingAsset").status).toBe("UNKNOWN");
    expect(result.status).toBe("UNKNOWN");
  });

  it("prefers FAIL over UNKNOWN when both are present", () => {
    // A rule that definitely failed is a stronger answer than one we could not evaluate.
    const result = evaluatePolicy(
      input({
        assetIdentity: null,
        draft: draft({ observations: { ...draft().observations, totalAssets: "1" } }),
      }),
    );

    expect(result.status).toBe("FAIL");
  });

  it("passes only on an unbroken sweep", () => {
    expect(overallStatus([])).toBe("PASS");
    expect(
      overallStatus([{ status: "PASS" }, { status: "UNKNOWN" }] as PolicyRuleResult[]),
    ).toBe("UNKNOWN");
    expect(overallStatus([{ status: "FAIL" }] as PolicyRuleResult[])).toBe("FAIL");
  });
});

describe("underlying asset", () => {
  it("passes a canonical asset in the allowlist", () => {
    expect(ruleFor(evaluatePolicy(input()), "underlyingAsset").status).toBe("PASS");
  });

  it("is UNKNOWN when asset() gave no answer", () => {
    expect(ruleFor(evaluatePolicy(input({ assetIdentity: null })), "underlyingAsset").status).toBe(
      "UNKNOWN",
    );
  });

  it("is UNKNOWN, not FAIL, for an address the registry does not recognise", () => {
    /*
     * We can only call an asset "outside the allowlist" once we know what it is. An unrecognised
     * address means identity was never established, which PRD section 8.3 lists under "asset
     * identity cannot be verified".
     */
    const result = evaluatePolicy(input({ assetIdentity: { canonicalKey: null } }));

    expect(ruleFor(result, "underlyingAsset").status).toBe("UNKNOWN");
  });

  it("fails a recognised asset that is outside the allowlist", () => {
    const result = evaluatePolicy(input({ assetIdentity: { canonicalKey: "DAI" } }));

    expect(ruleFor(result, "underlyingAsset").status).toBe("FAIL");
    expect(ruleFor(result, "underlyingAsset").observedValue).toBe("DAI");
  });
});

describe("minimum history", () => {
  it("passes when the observations cover the window", () => {
    expect(ruleFor(evaluatePolicy(input()), "minimumHistory").status).toBe("PASS");
  });

  it("FAILS when the vault is younger than the window", () => {
    /*
     * The distinction this rule exists to make. The vault cannot have 30 days of history because it
     * has only existed for two, and no further indexing would change that.
     */
    const result = evaluatePolicy(
      input({
        policy: policy({ minHistoryDays: 30 }),
        vaultDeployedAt: "2026-09-02T12:00:00.000Z",
      }),
    );

    expect(ruleFor(result, "minimumHistory").status).toBe("FAIL");
    expect(ruleFor(result, "minimumHistory").observedValue).toContain("since deployment");
  });

  it("is UNKNOWN when the vault is old enough but our coverage is short", () => {
    // Our shortcoming, not the vault's. This is the case the 7-day declared window produces today
    // against a 30-day policy, and it must not read as a failure of the vault.
    const result = evaluatePolicy(input({ policy: policy({ minHistoryDays: 30 }) }));

    expect(ruleFor(result, "minimumHistory").status).toBe("UNKNOWN");
    expect(ruleFor(result, "minimumHistory").reasonCodes).toContain("MISSING_OBSERVATION");
  });

  it("is UNKNOWN when the deployment time is not known", () => {
    // Without an age we cannot claim the vault is too young, so we must not.
    const result = evaluatePolicy(
      input({ policy: policy({ minHistoryDays: 30 }), vaultDeployedAt: null }),
    );

    expect(ruleFor(result, "minimumHistory").status).toBe("UNKNOWN");
  });

  it("is UNKNOWN when there is no start observation at all", () => {
    const result = evaluatePolicy(input({ draft: draft({ elapsedSeconds: null }) }));

    expect(ruleFor(result, "minimumHistory").status).toBe("UNKNOWN");
  });
});

describe("minimum TVL", () => {
  it("passes at exactly the threshold", () => {
    const result = evaluatePolicy(
      input({
        draft: draft({ observations: { ...draft().observations, totalAssets: "2000000000000" } }),
      }),
    );

    expect(ruleFor(result, "minimumTvl").status).toBe("PASS");
  });

  it("fails one base unit below the threshold", () => {
    const result = evaluatePolicy(
      input({
        draft: draft({ observations: { ...draft().observations, totalAssets: "1999999999999" } }),
      }),
    );

    expect(ruleFor(result, "minimumTvl").status).toBe("FAIL");
  });

  it("compares as integers, not as numbers", () => {
    // Above Number.MAX_SAFE_INTEGER, a float comparison would silently go wrong.
    const huge = "9007199254740993000000";
    const result = evaluatePolicy(
      input({
        policy: policy({ minTvlAssets: "9007199254740992000000" }),
        draft: draft({ observations: { ...draft().observations, totalAssets: huge } }),
      }),
    );

    expect(ruleFor(result, "minimumTvl").status).toBe("PASS");
  });

  it("is UNKNOWN when the read reverted", () => {
    const result = evaluatePolicy(
      input({
        draft: draft({
          observations: { ...draft().observations, totalAssets: null },
          reasonCodes: ["CALL_REVERTED"],
        }),
      }),
    );

    expect(ruleFor(result, "minimumTvl").status).toBe("UNKNOWN");
    expect(ruleFor(result, "minimumTvl").reasonCodes).toContain("CALL_REVERTED");
  });
});

describe("minimum observed return", () => {
  it("passes at exactly the threshold", () => {
    const result = evaluatePolicy(input({ policy: policy({ minObservedReturnBps: { windowDays: 7, value: 108 } }) }));

    expect(ruleFor(result, "minimumObservedReturn").status).toBe("PASS");
  });

  it("fails one basis point below", () => {
    const result = evaluatePolicy(
      input({ policy: policy({ minObservedReturnBps: { windowDays: 7, value: 109 } }) }),
    );

    expect(ruleFor(result, "minimumObservedReturn").status).toBe("FAIL");
  });

  it("passes a negative return against a negative tolerance", () => {
    const result = evaluatePolicy(
      input({
        policy: policy({ minObservedReturnBps: { windowDays: 7, value: -100 } }),
        draft: draft({
          observations: {
            ...draft().observations,
            shareValue: { ...draft().observations.shareValue!, returnBps: -50 },
          },
        }),
      }),
    );

    expect(ruleFor(result, "minimumObservedReturn").status).toBe("PASS");
  });

  it("is UNKNOWN when the return was measured over a different window", () => {
    // A 30-day return does not answer a question about 7 days; comparing them would be a category
    // error dressed up as a decision.
    const result = evaluatePolicy(
      input({ policy: policy({ minObservedReturnBps: { windowDays: 30, value: 0 } }) }),
    );

    expect(ruleFor(result, "minimumObservedReturn").status).toBe("UNKNOWN");
    expect(ruleFor(result, "minimumObservedReturn").observedValue).toContain("over 7 days");
  });

  it("is UNKNOWN when no return could be computed", () => {
    const result = evaluatePolicy(
      input({
        draft: draft({
          observations: { ...draft().observations, shareValue: null },
          reasonCodes: ["MISSING_OBSERVATION"],
        }),
      }),
    );

    expect(ruleFor(result, "minimumObservedReturn").status).toBe("UNKNOWN");
  });

  it("carries the incompatibility reason the draft recorded", () => {
    const result = evaluatePolicy(
      input({
        draft: draft({
          observations: { ...draft().observations, shareValue: null },
          reasonCodes: ["INCOMPATIBLE_IMPLEMENTATION"],
        }),
      }),
    );

    expect(ruleFor(result, "minimumObservedReturn").reasonCodes).toContain(
      "INCOMPATIBLE_IMPLEMENTATION",
    );
  });
});

describe("minimum withdrawable assets", () => {
  it("passes when the supported value clears the threshold", () => {
    expect(ruleFor(evaluatePolicy(input()), "minimumWithdrawableAssets").status).toBe("PASS");
  });

  it("fails when a supported value is below the threshold", () => {
    const result = evaluatePolicy(
      input({
        draft: draft({ observations: { ...draft().observations, maxWithdrawAssets: "1" } }),
      }),
    );

    expect(ruleFor(result, "minimumWithdrawableAssets").status).toBe("FAIL");
  });

  it("is UNKNOWN, not FAIL, for a documented non-standard zero", () => {
    /*
     * The case the whole capability model exists for. Morpho Vault V2 documents maxWithdraw
     * returning zero for an owner who holds shares; the evidence engine reports that as an
     * unavailable figure rather than a real zero, and the rule must not turn it into a failure.
     */
    const result = evaluatePolicy(
      input({
        draft: draft({
          observations: { ...draft().observations, maxWithdrawAssets: null },
          reasonCodes: ["AMBIGUOUS_CAPABILITY"],
        }),
      }),
    );

    const rule = ruleFor(result, "minimumWithdrawableAssets");

    expect(rule.status).toBe("UNKNOWN");
    expect(rule.status).not.toBe("FAIL");
    expect(rule.reasonCodes).toContain("AMBIGUOUS_CAPABILITY");
    expect(result.status).toBe("UNKNOWN");
  });

  it("is UNKNOWN when the reads were taken for a different wallet", () => {
    // Evidence about one account must never satisfy a rule written about another.
    const result = evaluatePolicy(
      input({ observedOwner: "0x2222222222222222222222222222222222222222" }),
    );

    const rule = ruleFor(result, "minimumWithdrawableAssets");

    expect(rule.status).toBe("UNKNOWN");
    expect(rule.reasonCodes).toContain("WALLET_CONTEXT_CHANGED");
  });

  it("matches an owner regardless of address casing", () => {
    const result = evaluatePolicy(input({ observedOwner: OWNER.toUpperCase().replace("0X", "0x") }));

    expect(ruleFor(result, "minimumWithdrawableAssets").status).toBe("PASS");
  });

  it("is UNKNOWN when no account reads were taken", () => {
    expect(
      ruleFor(evaluatePolicy(input({ observedOwner: null })), "minimumWithdrawableAssets").status,
    ).toBe("UNKNOWN");
  });
});

describe("output contract", () => {
  it("never leaves an UNKNOWN rule without a reason", () => {
    // An unexplained UNKNOWN is indistinguishable from a bug.
    const results = [
      evaluatePolicy(input({ assetIdentity: null })),
      evaluatePolicy(input({ observedOwner: null })),
      evaluatePolicy(input({ policy: policy({ minHistoryDays: 30 }) })),
    ];

    for (const result of results) {
      for (const rule of result.rules.filter((entry) => entry.status === "UNKNOWN")) {
        expect(rule.reasonCodes.length).toBeGreaterThan(0);
      }
    }
  });

  it("returns exactly the five rule keys, once each", () => {
    const keys = evaluatePolicy(input()).rules.map((rule) => rule.key);

    expect(new Set(keys).size).toBe(5);
  });

  it("is deterministic", () => {
    expect(evaluatePolicy(input())).toEqual(evaluatePolicy(input()));
  });
});
