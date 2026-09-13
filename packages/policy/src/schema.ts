import { policyV1JsonSchema, policyV1Schema, type PolicyV1 } from "@tr4ce/domain";
import { z } from "zod";

/**
 * The validation boundary.
 *
 * Everything that reaches the evaluator passes through here first, whatever produced it — a form, a
 * stored record, or a language model's draft. The schema itself lives in `@tr4ce/domain` so exactly
 * one definition exists; this module adds the structured failure reporting the UI needs, because a
 * user has to see what is wrong with a policy before they can confirm it (TR-F-024).
 */

/** Published JSON Schema for a policy draft. Re-exported so consumers need one import. */
export const policyJsonSchema = policyV1JsonSchema;

export interface PolicyIssue {
  /** Dotted path to the offending field, or `""` for the policy as a whole. */
  path: string;
  message: string;
}

export type PolicyValidation =
  | { valid: true; policy: PolicyV1 }
  | { valid: false; issues: PolicyIssue[] };

/**
 * Validate an untrusted value against the policy contract.
 *
 * Returns issues rather than throwing: a rejected draft is an ordinary outcome that the user is
 * shown and asked to correct, not an exceptional one. Unknown keys are rejected, never stripped —
 * see the note in `@tr4ce/domain`'s policy module for why silently discarding them would break the
 * promise that the previewed policy is the policy that runs.
 */
export function validatePolicy(candidate: unknown): PolicyValidation {
  const result = policyV1Schema.safeParse(candidate);

  if (result.success) {
    return { valid: true, policy: result.data };
  }

  return { valid: false, issues: toIssues(result.error) };
}

/**
 * Validate, or throw.
 *
 * For call sites that have already validated and are re-parsing a stored record, where a failure
 * means the database disagrees with the code and there is nothing sensible to show a user.
 */
export function parsePolicy(candidate: unknown): PolicyV1 {
  const validation = validatePolicy(candidate);

  if (!validation.valid) {
    throw new Error(
      `Policy failed validation: ${validation.issues
        .map((issue) => `${issue.path || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return validation.policy;
}

function toIssues(error: z.ZodError): PolicyIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
