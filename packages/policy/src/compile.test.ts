import { describe, expect, it } from "vitest";

import {
  compilePolicyDraft,
  disabledCompiler,
  type PolicyDraftCompiler,
} from "./compile.js";
import { validatePolicy } from "./schema.js";

const VALID_DRAFT = {
  version: 1,
  underlyingAssets: ["USDC"],
  minHistoryDays: 30,
  minTvlAssets: "2000000000000",
  minObservedReturnBps: { windowDays: 7, value: 0 },
  minWithdrawableAssets: {
    owner: "0x1111111111111111111111111111111111111111",
    value: "10000000000",
  },
};

/** A stand-in provider. Whatever it returns is untrusted, exactly like a real one. */
const compilerReturning = (value: unknown): PolicyDraftCompiler => ({
  name: "stub",
  draft: () => Promise.resolve(value),
});

const request = { prompt: "USDC vaults with 30 days of history and at least 2m TVL" };

describe("the disabled default", () => {
  it("is what ships, and the product works without a provider", () => {
    // POLICY_LLM_PROVIDER=disabled in .env.example. The typed form is the primary path, not a
    // fallback for when the model is unavailable.
    expect(disabledCompiler.name).toBe("disabled");
  });

  it("produces no policy at all", async () => {
    const result = await compilePolicyDraft(disabledCompiler, request);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("disabled");
  });
});

describe("provider output is untrusted", () => {
  it("accepts a draft that satisfies the contract", async () => {
    const result = await compilePolicyDraft(compilerReturning(VALID_DRAFT), request);

    expect(result.ok).toBe(true);
    expect(result.ok && result.policy.minHistoryDays).toBe(30);
  });

  it("rejects a draft carrying an operator the contract does not define", async () => {
    /*
     * The acceptance clause, stated as a test: "the LLM cannot add an operator". A model that
     * invents comparison semantics gets its draft rejected, not silently stripped down to something
     * that looks valid.
     */
    const result = await compilePolicyDraft(
      compilerReturning({
        ...VALID_DRAFT,
        minObservedReturnBps: { windowDays: 7, value: 0, operator: "lte" },
      }),
      request,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid_draft");
  });

  it("rejects a draft that tries to smuggle in a rule decision", async () => {
    // The other half of the clause: a model cannot mark a rule as passing. There is no field for it
    // in the contract, so the attempt is simply rejected.
    const result = await compilePolicyDraft(
      compilerReturning({ ...VALID_DRAFT, rules: [{ key: "minimumTvl", status: "PASS" }] }),
      request,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects an entirely fabricated rule", async () => {
    const result = await compilePolicyDraft(
      compilerReturning({ ...VALID_DRAFT, maxDrawdownBps: 500 }),
      request,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects prose instead of JSON", async () => {
    const result = await compilePolicyDraft(
      compilerReturning("Sure! Here is a policy for USDC vaults."),
      request,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid_draft");
  });

  it("rejects null", async () => {
    expect((await compilePolicyDraft(compilerReturning(null), request)).ok).toBe(false);
  });

  it("rejects a float amount a model wrote as a number", async () => {
    const result = await compilePolicyDraft(
      compilerReturning({ ...VALID_DRAFT, minTvlAssets: 2_000_000.5 }),
      request,
    );

    expect(result.ok).toBe(false);
  });

  it("surfaces a provider failure as an ordinary outcome, not an exception", async () => {
    // A provider that is down must leave the user with the form, not a stack trace.
    const throwing: PolicyDraftCompiler = {
      name: "stub",
      draft: () => Promise.reject(new Error("upstream timeout")),
    };

    const result = await compilePolicyDraft(throwing, request);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("provider_error");
    expect(!result.ok && result.issues[0]?.message).toContain("upstream timeout");
  });

  it("reports what was wrong so the user can correct it", async () => {
    const result = await compilePolicyDraft(
      compilerReturning({ ...VALID_DRAFT, minHistoryDays: -5 }),
      request,
    );

    expect(!result.ok && result.issues.some((issue) => issue.path === "minHistoryDays")).toBe(true);
  });
});

describe("the boundary itself", () => {
  it("routes every provider output through the same validation the form uses", () => {
    /*
     * There is one gate, not two. A draft that a compiler produced and a draft a user typed are
     * validated by the identical schema, so a model can never reach the evaluator through a path a
     * human could not.
     */
    const invalid = { ...VALID_DRAFT, operator: "gte" };

    expect(validatePolicy(invalid).valid).toBe(false);
  });
});
