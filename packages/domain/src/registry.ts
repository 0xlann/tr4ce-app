import { z } from "zod";

import { addressSchema, blockHashSchema, blockNumberStringSchema, chainIdSchema } from "./identity.js";
import { vaultStatusSchema } from "./observations.js";
import { reasonCodeSchema } from "./reasons.js";

/** Protocol adapter identities recognised by the evidence pipeline. */
export const adapterKeySchema = z.enum(["erc4626", "morpho-v2", "yearn-v3"]);
export type AdapterKey = z.infer<typeof adapterKeySchema>;

/** Every ERC-4626 read TR4CE probes during vault onboarding. */
export const capabilityMethodSchema = z.enum([
  "asset",
  "decimals",
  "totalAssets",
  "totalSupply",
  "convertToAssets",
  "maxWithdraw",
  "maxRedeem",
  "previewDeposit",
  "previewRedeem",
]);
export type CapabilityMethod = z.infer<typeof capabilityMethodSchema>;

/**
 * Outcome of one probe. A documented non-standard zero is recorded as its own status so it can
 * never be reinterpreted as verified zero capacity; downstream it becomes UNKNOWN, not FAIL.
 */
export const capabilityStatusSchema = z.enum([
  "supported",
  "reverted",
  "nonstandard_zero",
  "ambiguous",
  "unsupported",
]);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export const capabilityProbeSchema = z.object({
  method: capabilityMethodSchema,
  status: capabilityStatusSchema,
  atBlock: blockNumberStringSchema,
  /** Raw ABI-encoded return data, or null when the call produced none. */
  rawResult: z.string().regex(/^0x[0-9a-fA-F]*$/).nullable(),
  revertData: z.string().regex(/^0x[0-9a-fA-F]*$/).nullable(),
  reasonCode: reasonCodeSchema.nullable(),
  note: z.string().nullable(),
});
export type CapabilityProbe = z.infer<typeof capabilityProbeSchema>;

/** Evidence produced by the ten-step onboarding gate in docs/technical/INTEGRATIONS.md §4. */
export const vaultOnboardingEvidenceSchema = z.object({
  verifiedAt: z.string().datetime(),
  /** Provider identity only. Never a URL or credential. */
  rpcProviderKey: z.string().min(1),
  codeHash: blockHashSchema,
  implementationAddress: addressSchema.nullable(),
  implementationCodeHash: blockHashSchema.nullable(),
  latestProbes: z.array(capabilityProbeSchema).min(1),
  /** Step 5 requires probing one explicit historical block, never a silent fallback to latest. */
  historicalProbes: z.array(capabilityProbeSchema).min(1),
  earliestFlowBlock: blockNumberStringSchema,
  earliestFlowTransactionHash: blockHashSchema,
  windowCoverageDays: z.number().int().positive(),
  sourceUrls: z.array(z.string().url()).min(1),
});
export type VaultOnboardingEvidence = z.infer<typeof vaultOnboardingEvidenceSchema>;

/** Seed record for the ERD `vault` and `vault_capability` tables. */
export const curatedVaultSchema = z.object({
  chainId: chainIdSchema,
  address: addressSchema,
  asset: addressSchema,
  assetCanonicalKey: z.literal("USDC"),
  protocolSlug: z.string().min(1),
  adapterKey: adapterKeySchema,
  adapterVersion: z.string().min(1),
  shareDecimals: z.number().int().min(0).max(77),
  assetDecimals: z.number().int().min(0).max(77),
  name: z.string().min(1),
  symbol: z.string().min(1),
  /** Provenance only. */
  deploymentBlock: blockNumberStringSchema,
  /** Drives the Substreams initialBlock. Pinning that to deploymentBlock forces a full replay. */
  windowStartBlock: blockNumberStringSchema,
  status: vaultStatusSchema,
  statusReason: z.string().nullable(),
  evidence: vaultOnboardingEvidenceSchema,
});
export type CuratedVault = z.infer<typeof curatedVaultSchema>;

export const canonicalAssetSchema = z.object({
  canonicalKey: z.literal("USDC"),
  chainId: chainIdSchema,
  address: addressSchema,
  decimals: z.number().int().min(0).max(77),
  /** Published deployment list. Identity must never rest on an untrusted ticker string. */
  sourceUrl: z.string().url(),
});
export type CanonicalAsset = z.infer<typeof canonicalAssetSchema>;

export const vaultManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  /** Substreams network identifier. */
  network: z.string().min(1),
  chainId: chainIdSchema,
  canonicalAssets: z.array(canonicalAssetSchema).min(1),
  vaults: z.array(curatedVaultSchema).min(1),
  snapshotCheckpointBlocks: z.number().int().positive(),
  declaredWindowDays: z.array(z.number().int().positive()).min(1),
});
export type VaultManifest = z.infer<typeof vaultManifestSchema>;

export const vaultManifestJsonSchema = z.toJSONSchema(vaultManifestSchema);
