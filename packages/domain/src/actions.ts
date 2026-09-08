import { z } from "zod";

import { baseUnitStringSchema } from "./amounts.js";
import { addressSchema, blockHashSchema, blockNumberStringSchema, chainIdSchema } from "./identity.js";
import { reasonCodeSchema } from "./reasons.js";

/**
 * Direct ERC-4626 calls, prepared but never sent.
 *
 * Nothing in this package or the services above it signs or submits. A prepared action is a
 * proposal the wallet owner approves transaction by transaction (PRD TR-F-036, TR-F-043); the only
 * thing TR4CE learns afterwards is a transaction hash the caller hands back.
 */

export const unsignedTransactionSchema = z.object({
  chainId: chainIdSchema,
  to: addressSchema,
  data: z.string().regex(/^0x[0-9a-fA-F]*$/, "Expected hexadecimal calldata"),
  value: baseUnitStringSchema,
  /**
   * What this call does, so a UI explaining a two-step deposit does not have to infer it from the
   * selector. Also part of the action digest: a plan whose first call is an approval is a
   * different plan from one whose first call is the deposit.
   */
  kind: z.enum(["approve", "deposit", "redeem"]),
});
export type UnsignedTransaction = z.infer<typeof unsignedTransactionSchema>;

export const actionSimulationSchema = z.object({
  status: z.enum(["SUCCEEDED", "FAILED"]),
  blockNumber: blockNumberStringSchema,
  blockHash: blockHashSchema,
  expiresAt: z.string().datetime(),
  gasEstimate: baseUnitStringSchema.nullable(),
  reasonCodes: z.array(reasonCodeSchema),
});
export type ActionSimulation = z.infer<typeof actionSimulationSchema>;

export const preparedActionV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"),
  actionId: z.string().regex(/^act_[A-Za-z0-9]+$/, "Expected a TR4CE action identifier"),
  operation: z.enum(["deposit", "redeem"]),
  vault: addressSchema,
  asset: addressSchema,
  owner: addressSchema,
  receiver: addressSchema,
  amount: baseUnitStringSchema,
  /**
   * Every call the operation needs, in the order they must be signed.
   *
   * An array rather than one transaction because a deposit is not always one call: when the
   * owner's allowance for the vault is short, an exact `approve` has to precede the `deposit`
   * (SMART-CONTRACT.md section 4). How many appear here is therefore an observation about the
   * chain at preparation time, not a property of the operation — and collapsing the pair into a
   * single field would have made the approval invisible in exactly the case a user most needs to
   * see it.
   *
   * The approval is always for the exact amount. TR4CE never requests an unlimited allowance
   * (PRD TR-F-034).
   */
  transactions: z.array(unsignedTransactionSchema).min(1),
  /**
   * What the vault previews for this amount — shares for a deposit, assets for a redemption
   * (PRD TR-F-030, TR-F-031).
   *
   * A preview, never a promise. It is kept so the actual figure the receipt reports can be shown
   * beside it afterwards; SMART-CONTRACT.md sections 4 and 5 require the actual to come from
   * execution evidence and to be "not replaced by preview".
   */
  previewed: baseUnitStringSchema,
  simulation: actionSimulationSchema,
});
export type PreparedActionV1 = z.infer<typeof preparedActionV1Schema>;

/**
 * What the chain did, next to what was previewed.
 *
 * `actual` is nullable and never falls back to `previewed`. A null says the vault's event was not
 * observed in that transaction, which is a different claim from "the two agreed" — and only one of
 * them would be true. Same reason `delta` is null rather than zero.
 */
export const actionOutcomeSchema = z.object({
  transactionHash: blockHashSchema,
  /** Null until the receipt has been observed. A reported hash is not yet an outcome. */
  status: z.enum(["success", "reverted"]).nullable(),
  confirmedBlockNumber: blockNumberStringSchema.nullable(),
  previewed: baseUnitStringSchema,
  actual: baseUnitStringSchema.nullable(),
  /** `actual - previewed`, signed — so it carries a minus sign the base-unit schema refuses. */
  delta: z.string().regex(/^-?(0|[1-9][0-9]*)$/, "Expected a signed integer").nullable(),
});
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
