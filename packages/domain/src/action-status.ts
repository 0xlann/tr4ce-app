import { z } from "zod";

/**
 * Enum-like values for the prepared-action tables (ERD.md section 7).
 *
 * Same contract as `observations.ts` and `reports.ts`: these `.options` arrays are what the CHECK
 * constraints in migrations/0004_prepared_actions.sql are generated from, and a test in @tr4ce/db
 * asserts the two still agree.
 */

/** The two operations TR4CE prepares. Nothing else is encodable — see `abis.test.ts`. */
export const actionKindSchema = z.enum(["deposit", "redeem"]);
export type ActionKind = z.infer<typeof actionKindSchema>;

/**
 * Where a prepared action stands.
 *
 * The sequence is `prepared → simulated → submitted → confirmed`, with `reverted` as the other
 * ending, and `expired` / `invalidated` as the two ways an action stops being signable without
 * ever reaching a chain. There is no `signed`: TR4CE never observes a signature, only a hash the
 * caller hands back after their wallet submitted (PRD TR-F-043).
 */
export const actionStatusSchema = z.enum([
  "prepared",
  "simulated",
  "submitted",
  "confirmed",
  "reverted",
  "expired",
  "invalidated",
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

/**
 * Why a simulated action stopped being signable.
 *
 * Kept apart from `reasonCodeSchema`, which explains missing evidence. A changed account is not a
 * gap in what we observed; it is a different question being asked.
 */
export const signabilityReasonSchema = z.enum([
  "BINDING_CHANGED",
  "BLOCK_BUDGET_SPENT",
  "TIME_BUDGET_SPENT",
  "SIMULATION_FAILED",
]);
export type SignabilityReason = z.infer<typeof signabilityReasonSchema>;

/** How a call failed, as `simulation.revert_class` records it. */
export const revertClassSchema = z.enum([
  "none",
  "reverted",
  "out_of_gas",
  "provider_unavailable",
  "unclassified",
]);
export type RevertClass = z.infer<typeof revertClassSchema>;
