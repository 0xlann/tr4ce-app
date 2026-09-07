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
  simulation: actionSimulationSchema,
});
export type PreparedActionV1 = z.infer<typeof preparedActionV1Schema>;
