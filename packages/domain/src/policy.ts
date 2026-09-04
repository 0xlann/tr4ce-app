import { z } from "zod";

import { baseUnitStringSchema, basisPointsSchema } from "./amounts.js";
import { addressSchema } from "./identity.js";
import { reasonCodeSchema } from "./reasons.js";

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

export const policyV1Schema = z.object({
  version: z.literal(1),
  underlyingAssets: z.array(z.literal("USDC")).min(1),
  minHistoryDays: z.number().int().positive(),
  minTvlAssets: baseUnitStringSchema,
  minObservedReturnBps: z.object({
    windowDays: z.number().int().positive(),
    value: basisPointsSchema,
  }),
  minWithdrawableAssets: z.object({
    owner: addressSchema,
    value: baseUnitStringSchema,
  }),
});
export type PolicyV1 = z.infer<typeof policyV1Schema>;

export const policyRuleResultSchema = z.object({
  key: policyRuleKeySchema,
  status: policyRuleStatusSchema,
  threshold: z.string(),
  observedValue: z.string().nullable(),
  evidenceReferences: z.array(z.string()),
  reasonCodes: z.array(reasonCodeSchema),
});
export type PolicyRuleResult = z.infer<typeof policyRuleResultSchema>;

export const policyEvaluationSchema = z.object({
  version: z.literal(1),
  status: policyRuleStatusSchema,
  rules: z.array(policyRuleResultSchema),
});
export type PolicyEvaluation = z.infer<typeof policyEvaluationSchema>;
