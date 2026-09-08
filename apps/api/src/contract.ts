import {
  actionOutcomeSchema,
  actionStatusSchema,
  addressSchema,
  apiErrorSchema,
  baseUnitStringSchema,
  blockHashSchema,
  blockNumberStringSchema,
  chainIdSchema,
  evidenceReportV1Schema,
  policyEvaluationSchema,
  policyV1Schema,
  preparedActionV1Schema,
  revertClassSchema,
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

export const prepareActionRequestSchema = z.strictObject({
  chainId: chainIdSchema,
  vaultAddress: addressSchema,
  operation: z.enum(["deposit", "redeem"]),
  owner: addressSchema,
  receiver: addressSchema,
  /**
   * Base units — assets for a deposit, shares for a redemption. A decimal string, never a JSON
   * number: a uint256 amount does not survive a double.
   */
  amount: baseUnitStringSchema,
  /** The report that motivated this, when one did. Evidence, never a precondition. */
  reportId: z.string().regex(/^trc_[0-9a-f]{32}$/).nullish(),
});
export type PrepareActionRequest = z.infer<typeof prepareActionRequestSchema>;

export const preparedActionResponseSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  action: preparedActionV1Schema,
});

/** One recorded simulation attempt, newest first in the response. */
export const simulationAttemptSchema = z.strictObject({
  callIndex: z.number().int().nonnegative(),
  success: z.boolean(),
  blockNumber: blockNumberStringSchema,
  revertClass: revertClassSchema,
  gasEstimate: baseUnitStringSchema.nullable(),
  at: z.string().datetime(),
});

/**
 * Whether an action may still be signed, judged now rather than when it was stored.
 *
 * `signable` is the field a caller acts on. `status` says where the action stands, and the two are
 * separate because a submitted action is not signable for a completely different reason than an
 * expired one.
 *
 * `nextCallIndex` is what a wallet UI needs to know which transaction to put in front of the user.
 * A deposit whose allowance falls short is two calls, and after the first is reported the action is
 * signable again — for the second call, against its own simulation.
 */
export const actionStatusResponseSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  actionId: z.string().regex(/^act_[0-9a-f]{32}$/),
  status: actionStatusSchema,
  signable: z.boolean(),
  /** Null when signable. Otherwise which of the five ways it stopped being so. */
  reason: z.string().nullable(),
  expiresAt: z.string().datetime(),
  /** How many calls this action carries, and how many have had a hash reported. */
  callCount: z.number().int().positive(),
  sentCount: z.number().int().nonnegative(),
  /** The call awaiting signature, or null once every call has been reported. */
  nextCallIndex: z.number().int().nonnegative().nullable(),
  /**
   * The operation's own result, once its receipt has been observed.
   *
   * Null while the deposit or redemption has not been reported, or has been reported but not yet
   * mined. Never a placeholder built from the preview.
   */
  outcome: actionOutcomeSchema.nullable(),
  /** Every simulation attempt, newest first — including the ones the chain refused. */
  attempts: z.array(simulationAttemptSchema),
});
export type ActionStatusResponse = z.infer<typeof actionStatusResponseSchema>;

export const reportSubmissionRequestSchema = z.strictObject({
  chainId: chainIdSchema,
  /**
   * Which call of the action this hash belongs to.
   *
   * Required rather than inferred. A two-call deposit produces two hashes, and guessing which one
   * arrived is exactly how an approval's hash ends up recorded as the deposit's.
   */
  callIndex: z.number().int().nonnegative(),
  /**
   * The hash the caller's wallet produced.
   *
   * TR4CE never submits, so this is the only way a hash arrives — as a report about something that
   * already happened elsewhere (PRD TR-F-043).
   */
  transactionHash: blockHashSchema,
});
