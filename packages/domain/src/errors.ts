import { z } from "zod";

import { reasonCodeSchema } from "./reasons.js";

/**
 * The one error shape every HTTP route returns (PRD TR-F-040: "versioned JSON responses and
 * structured errors").
 *
 * Defined here rather than in the API app because it is part of the published contract: it appears
 * in the generated OpenAPI document, and a route that invented its own shape would have that
 * inconsistency frozen into the schema by the drift check.
 */

/**
 * Why a request could not be answered.
 *
 * Deliberately distinct from `reasonCodeSchema`: a reason code explains why *evidence* is missing
 * and belongs inside a report, while these describe why a *request* failed. A vault the registry
 * has never heard of is not a gap in our observations.
 */
export const apiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNKNOWN_VAULT",
  "INSUFFICIENT_OBSERVATIONS",
  "INCOMPLETE_EVIDENCE",
  "INVALID_POLICY",
  "REPORT_NOT_FOUND",
  /* An action the chain will not accept right now — a short balance, a limit, a reverted preview. */
  "ACTION_NOT_AVAILABLE",
  "ACTION_NOT_FOUND",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** One field-level validation failure, flattened out of a zod issue. */
export const apiErrorIssueSchema = z.strictObject({
  /** Dotted path into the request body, or `""` for the body itself. */
  path: z.string(),
  message: z.string().min(1),
});
export type ApiErrorIssue = z.infer<typeof apiErrorIssueSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    /**
     * Machine reasons carried through from the evidence engine.
     *
     * Present when the request failed *because* evidence was missing, which is the case a caller
     * most often needs to act on: it is the difference between "ask again later" and "this vault
     * will never answer".
     */
    reasonCodes: z.array(reasonCodeSchema),
    /** Empty unless the failure was a schema rejection. */
    issues: z.array(apiErrorIssueSchema),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const apiErrorJsonSchema = z.toJSONSchema(apiErrorSchema);
