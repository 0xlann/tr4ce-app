import { z } from "zod";

import { baseUnitStringSchema } from "./amounts.js";
import { addressSchema, blockHashSchema, blockNumberStringSchema, chainIdSchema } from "./identity.js";
import { reasonCodeSchema } from "./reasons.js";

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
  unsignedTransaction: unsignedTransactionSchema,
  simulation: actionSimulationSchema,
});
export type PreparedActionV1 = z.infer<typeof preparedActionV1Schema>;
