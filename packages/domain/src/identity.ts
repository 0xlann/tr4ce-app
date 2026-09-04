import { z } from "zod";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const unsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;

export const addressSchema = z.string().regex(addressPattern, "Expected a 20-byte EVM address").brand<"Address">();
export type Address = z.infer<typeof addressSchema>;

export const chainIdSchema = z.number().int().safe().positive().brand<"ChainId">();
export type ChainId = z.infer<typeof chainIdSchema>;

export const blockNumberStringSchema = z
  .string()
  .regex(unsignedDecimalPattern, "Expected a non-negative decimal block number")
  .brand<"BlockNumberString">();
export type BlockNumberString = z.infer<typeof blockNumberStringSchema>;

export const blockHashSchema = z.string().regex(hashPattern, "Expected a 32-byte block hash").brand<"BlockHash">();
export type BlockHash = z.infer<typeof blockHashSchema>;

export const blockRefSchema = z.object({
  blockNumber: blockNumberStringSchema,
  blockHash: blockHashSchema,
  timestamp: z.string().datetime(),
});
export type BlockRef = z.infer<typeof blockRefSchema>;

export const vaultIdentitySchema = z.object({
  chainId: chainIdSchema,
  address: addressSchema,
  asset: addressSchema,
  assetSymbol: z.literal("USDC"),
});
export type VaultIdentity = z.infer<typeof vaultIdentitySchema>;
