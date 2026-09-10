import { addressSchema, chainIdSchema, policyRuleStatusSchema } from "@tr4ce/domain";
import { z } from "zod";

/**
 * The shape the policy panel and its route handler agree on.
 *
 * Separate from the route module because both sides need it: a `route.ts` is expected to export
 * handlers, and the client component that posts to it has to parse what comes back. Same discipline
 * as the HTTP contract one layer down — parsed on both sides, never cast.
 */

export const evaluationRequestSchema = z.strictObject({
  chainId: chainIdSchema,
  vaultAddresses: z.array(addressSchema).min(1).max(20),
  windowDays: z.number().int().positive().max(365),
  /** Unknown on purpose: a draft may be invalid, and the answer to that is issues, not a rejection. */
  policy: z.unknown(),
});

export const evaluationIssueSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});

export const evaluatedRuleSchema = z.strictObject({
  key: z.string(),
  status: policyRuleStatusSchema,
  threshold: z.string(),
  /** Null when the observation the rule needed was not available. Never a zero standing in for it. */
  observedValue: z.string().nullable(),
  reasonCodes: z.array(z.string()),
});

/** What the panel renders per vault: a verdict, or the reason there is none. */
export const evaluationOutcomeSchema = z.strictObject({
  vaultAddress: addressSchema,
  status: policyRuleStatusSchema.nullable(),
  asOfBlock: z.string().nullable(),
  rules: z.array(evaluatedRuleSchema).nullable(),
  /** Set when the policy itself is malformed, or when the API refused for this vault. */
  issues: z.array(evaluationIssueSchema),
  unavailable: z.string().nullable(),
});

export const evaluationResponseSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  outcomes: z.array(evaluationOutcomeSchema),
});

export type EvaluationRequest = z.infer<typeof evaluationRequestSchema>;
export type EvaluationIssue = z.infer<typeof evaluationIssueSchema>;
export type EvaluationOutcome = z.infer<typeof evaluationOutcomeSchema>;
export type EvaluatedRule = z.infer<typeof evaluatedRuleSchema>;
export type EvaluationResponse = z.infer<typeof evaluationResponseSchema>;
