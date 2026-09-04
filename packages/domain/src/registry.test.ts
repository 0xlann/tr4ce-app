import { describe, expect, it } from "vitest";

import { curatedVaultSchema, vaultManifestJsonSchema, vaultManifestSchema } from "./index.js";

const probe = {
  method: "totalAssets",
  status: "supported",
  atBlock: "24500123",
  rawResult: "0x00000000000000000000000000000000000000000000000000000003d1e38e00",
  revertData: null,
  reasonCode: null,
  note: null,
};

const validVault = {
  chainId: 8453,
  address: "0x1111111111111111111111111111111111111111",
  asset: "0x2222222222222222222222222222222222222222",
  assetCanonicalKey: "USDC",
  protocolSlug: "example-protocol",
  adapterKey: "erc4626",
  adapterVersion: "1.0.0",
  shareDecimals: 18,
  assetDecimals: 6,
  name: "Example Vault",
  symbol: "exVLT",
  deploymentBlock: "20000000",
  windowStartBlock: "24200000",
  status: "listed",
  statusReason: null,
  evidence: {
    verifiedAt: "2026-09-04T00:00:00.000Z",
    rpcProviderKey: "example-provider",
    codeHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    implementationAddress: null,
    implementationCodeHash: null,
    latestProbes: [probe],
    historicalProbes: [{ ...probe, atBlock: "24200000" }],
    earliestFlowBlock: "20000100",
    earliestFlowTransactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    windowCoverageDays: 30,
    sourceUrls: ["https://example.org/deployments"],
  },
};

const validManifest = {
  schemaVersion: "1.0.0",
  network: "base",
  chainId: 8453,
  canonicalAssets: [
    {
      canonicalKey: "USDC",
      chainId: 8453,
      address: "0x2222222222222222222222222222222222222222",
      decimals: 6,
      sourceUrl: "https://example.org/usdc-deployments",
    },
  ],
  vaults: [validVault],
  snapshotCheckpointBlocks: 1800,
  declaredWindowDays: [7, 30],
};

describe("@tr4ce/domain vault registry", () => {
  it("round-trips a valid manifest through JSON and publishes JSON Schema", () => {
    const manifest = vaultManifestSchema.parse(JSON.parse(JSON.stringify(validManifest)));

    expect(manifest).toEqual(validManifest);
    expect(vaultManifestJsonSchema).toMatchObject({ type: "object" });
  });

  it("rejects a vault whose onboarding evidence omits the deployed code hash", () => {
    const { codeHash: _codeHash, ...evidenceWithoutCodeHash } = validVault.evidence;

    expect(() => curatedVaultSchema.parse({ ...validVault, evidence: evidenceWithoutCodeHash })).toThrow();
  });

  it("rejects a vault whose onboarding evidence omits the verification timestamp", () => {
    const { verifiedAt: _verifiedAt, ...evidenceWithoutTimestamp } = validVault.evidence;

    expect(() => curatedVaultSchema.parse({ ...validVault, evidence: evidenceWithoutTimestamp })).toThrow();
  });

  it("rejects a vault that was never probed at an explicit historical block", () => {
    expect(() =>
      curatedVaultSchema.parse({ ...validVault, evidence: { ...validVault.evidence, historicalProbes: [] } }),
    ).toThrow();
  });

  it("rejects an underlying asset outside the USDC-only MVP scope", () => {
    expect(() => curatedVaultSchema.parse({ ...validVault, assetCanonicalKey: "DAI" })).toThrow();
  });

  it("rejects an unknown protocol adapter", () => {
    expect(() => curatedVaultSchema.parse({ ...validVault, adapterKey: "aave-v3" })).toThrow();
  });

  it("keeps block numbers as unprefixed integer decimal strings", () => {
    expect(() => curatedVaultSchema.parse({ ...validVault, windowStartBlock: "0x1712c30" })).toThrow();
    expect(() => curatedVaultSchema.parse({ ...validVault, windowStartBlock: "24200000.5" })).toThrow();
    expect(() => curatedVaultSchema.parse({ ...validVault, windowStartBlock: 24200000 })).toThrow();
  });

  it("rejects a manifest with no curated vaults", () => {
    expect(() => vaultManifestSchema.parse({ ...validManifest, vaults: [] })).toThrow();
  });

  it("rejects a canonical asset without a published source", () => {
    const [asset] = validManifest.canonicalAssets;
    const { sourceUrl: _sourceUrl, ...assetWithoutSource } = asset!;

    expect(() => vaultManifestSchema.parse({ ...validManifest, canonicalAssets: [assetWithoutSource] })).toThrow();
  });
});
