import type { PolicyV1 } from "@tr4ce/domain";

import { validatePolicy, type PolicyIssue } from "./schema.js";

/**
 * The optional natural-language front door.
 *
 * A model may propose a policy. It may not decide anything. Two properties enforce that, and both
 * are structural rather than conventional:
 *
 *   1. A compiler returns `unknown`. The only route from `unknown` to `PolicyV1` runs through the
 *      strict schema, so an unrecognised key or a malformed amount cannot reach the evaluator.
 *   2. Nothing in this module can produce a `PolicyRuleResult`. There is no type path from a
 *      compiler's output to a rule decision, so "the model cannot mark a rule as passing" is a
 *      property of the code rather than a promise about how it is used.
 *
 * The product works with this disabled. `POLICY_LLM_PROVIDER=disabled` is the default in
 * `.env.example`, and the manual typed form is the primary path, not a fallback.
 */

export interface PolicyDraftRequest {
  /** The user's own words. Never executed, never trusted. */
  prompt: string;
}

export type PolicyDraftResult =
  | { ok: true; policy: PolicyV1 }
  | { ok: false; reason: "disabled" | "provider_error" | "invalid_draft"; issues: PolicyIssue[] };

/**
 * A source of policy drafts.
 *
 * Returns `unknown` on purpose: an implementation that returned `PolicyV1` would be asserting the
 * validity of its own output, which is exactly the authority this boundary withholds.
 */
export interface PolicyDraftCompiler {
  readonly name: string;
  draft(request: PolicyDraftRequest): Promise<unknown>;
}

/** The default. Drafting is off; the typed form is the way policies are written. */
export const disabledCompiler: PolicyDraftCompiler = {
  name: "disabled",
  draft() {
    return Promise.reject(new Error("Policy drafting is disabled."));
  },
};

/**
 * Run a compiler and validate whatever it produced.
 *
 * A provider that throws, times out, or returns prose instead of JSON is an ordinary outcome here,
 * not an exception to handle elsewhere: the caller gets a typed failure and the user gets the form.
 */
export async function compilePolicyDraft(
  compiler: PolicyDraftCompiler,
  request: PolicyDraftRequest,
): Promise<PolicyDraftResult> {
  if (compiler.name === "disabled") {
    return { ok: false, reason: "disabled", issues: [] };
  }

  let candidate: unknown;

  try {
    candidate = await compiler.draft(request);
  } catch (error) {
    return {
      ok: false,
      reason: "provider_error",
      issues: [{ path: "", message: error instanceof Error ? error.message : String(error) }],
    };
  }

  const validation = validatePolicy(candidate);

  if (!validation.valid) {
    return { ok: false, reason: "invalid_draft", issues: validation.issues };
  }

  return { ok: true, policy: validation.policy };
}
