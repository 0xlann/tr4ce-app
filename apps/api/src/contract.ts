import {
  addressSchema,
  apiErrorSchema,
  blockNumberStringSchema,
  chainIdSchema,
  evidenceReportV1Schema,
  policyEvaluationSchema,
  policyV1Schema,
  vaultStatusSchema,
} from "@tr4ce/domain";
import { z } from "zod";

/**
 * The HTTP contract.
 *
 * Every request and response shape is a zod schema, and every handler parses through it in both
 * directions. That is what makes Task 6's second acceptance clause — "HTTP output equals the domain
 * schema exactly" — a property of the code rather than a promise about it: a response assembled
 * incorrectly fails here, at the boundary, rather than reaching a client.
 *
 * These schemas are also the only source of the OpenAPI document. `scripts/openapi.ts` derives it
 * with `z.toJSONSchema`, so there is no hand-maintained copy to drift (TECH-STACK.md section 8).
 */

export const vaultSummarySchema = z.strictObject({
  chainId: chainIdSchema,
  address: addressSchema,
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  asset: addressSchema,
  assetSymbol: z.string().nullable(),
  shareDecimals: z.number().int().nonnegative(),
  status: vaultStatusSchema,
  /** The adapter interpreting this vault's reads at the newest capability profile. */
  adapterKey: z.string(),
  adapterVersion: z.string(),
});
export type VaultSummary = z.infer<typeof vaultSummarySchema>;

export const vaultListResponseSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  vaults: z.array(vaultSummarySchema),
});

export const createReportRequestSchema = z.strictObject({
  chainId: chainIdSchema,
  vaultAddress: addressSchema,
  /**
   * The window the caller is asking about.
   *
   * A request, not a guarantee: observations exist where the chain gave us one. The report states
   * the elapsed time it actually measured.
   */
  windowDays: z.number().int().positive().max(365),
  policy: policyV1Schema,
  /** Names the policy so two different policies for one wallet stay distinguishable. */
  policyName: z.string().min(1).max(120).default("default"),
});
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

export const reportResponseSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  /** False when this request matched a report that already existed. */
  created: z.boolean(),
  report: evidenceReportV1Schema,
});
export type ReportResponse = z.infer<typeof reportResponseSchema>;

export const evaluatePolicyRequestSchema = z.strictObject({
  chainId: chainIdSchema,
  vaultAddress: addressSchema,
  windowDays: z.number().int().positive().max(365),
  /**
   * Unknown, deliberately.
   *
   * This endpoint exists to tell a caller whether a candidate policy is valid, so it must accept
   * something that might not be and answer with issues rather than a parse failure. The strict
   * schema is applied inside the handler, where a rejection becomes a structured response.
   */
  policy: z.unknown(),
});

export const evaluatePolicyResponseSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  /** Present only when the candidate policy was valid. */
  evaluation: policyEvaluationSchema.nullable(),
  /** Empty when the policy validated. */
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })),
  /** The block the evaluation was taken at, so a caller can reproduce it. */
  asOfBlock: blockNumberStringSchema.nullable(),
});

export { apiErrorSchema };
