import { z } from "zod";

import { baseUnitStringSchema, basisPointsSchema } from "./amounts.js";
import { addressSchema } from "./identity.js";
import { reasonCodeSchema } from "./reasons.js";

/**
 * Policy contract.
 *
 * Every object here is strict. A policy may originate from a natural-language draft, so an
 * unrecognised key is untrusted input, not a harmless extra: zod's default `z.object` would strip
 * it silently, and a user reviewing the typed policy would never learn that something they wrote —
 * or something a model invented — had been discarded. Rejecting is the only outcome that keeps the
 * preview a user confirms (TR-F-024) equal to the policy that actually runs.
 */

export const policyRuleStatusSchema = z.enum(["PASS", "FAIL", "UNKNOWN"]);
export type PolicyRuleStatus = z.infer<typeof policyRuleStatusSchema>;

export const policyRuleKeySchema = z.enum([
  "underlyingAsset",
  "minimumHistory",
  "minimumTvl",
  "minimumObservedReturn",
  "minimumWithdrawableAssets",
]);
export type PolicyRuleKey = z.infer<typeof policyRuleKeySchema>;

/**
 * The five MVP rules — PRD section 8.2.
 *
 * All five fields are required, so every rule is always evaluated and every rule is "required" in
 * the overall-status truth table. There is deliberately no mechanism for an optional rule: a policy
 * a user cannot fully see is not a policy they can meaningfully confirm.
 */
export const policyV1Schema = z.strictObject({
  version: z.literal(1),
  underlyingAssets: z.array(z.literal("USDC")).min(1),
  minHistoryDays: z.number().int().positive(),
  /** Base-unit decimal string. A JSON number is rejected, not coerced. */
  minTvlAssets: baseUnitStringSchema,
  minObservedReturnBps: z.strictObject({
    windowDays: z.number().int().positive(),
    value: basisPointsSchema,
  }),
  minWithdrawableAssets: z.strictObject({
    owner: addressSchema,
    value: baseUnitStringSchema,
  }),
});
export type PolicyV1 = z.infer<typeof policyV1Schema>;

/**
 * One rule's decision.
 *
 * Strict for a sharper reason than the policy itself: this is what the evaluator produces, and the
 * acceptance clause for the policy layer is that a language model cannot mark a rule as passing.
 * A schema that quietly accepted extra fields on a rule result would make that guarantee depend on
 * nothing but convention.
 */
export const policyRuleResultSchema = z.strictObject({
  key: policyRuleKeySchema,
  status: policyRuleStatusSchema,
  threshold: z.string(),
  /** Null when the rule could not observe a value at all. Never a stand-in figure. */
  observedValue: z.string().nullable(),
  evidenceReferences: z.array(z.string()),
  reasonCodes: z.array(reasonCodeSchema),
});
export type PolicyRuleResult = z.infer<typeof policyRuleResultSchema>;

export const policyEvaluationSchema = z.strictObject({
  version: z.literal(1),
  status: policyRuleStatusSchema,
  rules: z.array(policyRuleResultSchema),
});
export type PolicyEvaluation = z.infer<typeof policyEvaluationSchema>;

/** Published contract for policy drafts, including those a model proposes. */
export const policyV1JsonSchema = z.toJSONSchema(policyV1Schema);
