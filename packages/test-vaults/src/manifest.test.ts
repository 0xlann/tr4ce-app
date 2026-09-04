import { describe, expect, it } from "vitest";

import { baseUsdcVaultManifest, listedVaults, parseManifest, substreamsParams } from "./index.js";

const probe = {
  method: "totalAssets",
  status: "supported",
  atBlock: "24500123",
  rawResult: "0x00",
  revertData: null,
  reasonCode: null,
  note: null,
};

function vault(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    address: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
    asset: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
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
      codeHash: `0x${"cd".repeat(32)}`,
      implementationAddress: null,
      implementationCodeHash: null,
      latestProbes: [probe],
      historicalProbes: [{ ...probe, atBlock: "24200000" }],
      earliestFlowBlock: "20000100",
      earliestFlowTransactionHash: `0x${"ef".repeat(32)}`,
      windowCoverageDays: 30,
      sourceUrls: ["https://example.org/deployments"],
    },
    ...overrides,
  };
}

function manifest(vaults: unknown[]) {
  return {
    schemaVersion: "1.0.0",
    network: "base",
    chainId: 8453,
    canonicalAssets: [
      {
        canonicalKey: "USDC",
        chainId: 8453,
        address: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
        decimals: 6,
        sourceUrl: "https://example.org/usdc-deployments",
      },
    ],
    vaults,
    snapshotCheckpointBlocks: 1800,
    declaredWindowDays: [7, 30],
  };
}

describe("@tr4ce/test-vaults", () => {
  it("renders the exact params format the Rust module parses", () => {
    const parsed = parseManifest(manifest([vault()]));

    // Mirrored by Config::parse in substreams/erc4626/src/config.rs. Addresses are lowercase and
    // unprefixed because the module compares raw bytes, never formatted strings.
    expect(substreamsParams(parsed)).toBe(
      "chain_id=8453" +
        "&anchor_block=24200000" +
        "&checkpoint_interval=1800" +
        `&vaults=${"aa".repeat(20)}:${"bb".repeat(20)}:18:6`,
    );
  });

  it("anchors the window at the earliest listed vault start block", () => {
    const parsed = parseManifest(
      manifest([
        vault({ windowStartBlock: "24400000" }),
        vault({ address: `0x${"cc".repeat(20)}`, windowStartBlock: "24100000" }),
      ]),
    );

    expect(substreamsParams(parsed)).toContain("anchor_block=24100000");
  });

  it("excludes vaults that did not pass the full onboarding gate", () => {
    const parsed = parseManifest(
      manifest([
        vault(),
        vault({ address: `0x${"cc".repeat(20)}`, status: "candidate", statusReason: "history too short" }),
      ]),
    );

    expect(listedVaults(parsed)).toHaveLength(1);
    expect(substreamsParams(parsed)).not.toContain("cc".repeat(20));
  });

  it("refuses to build a params string when nothing is listed", () => {
    const parsed = parseManifest(manifest([vault({ status: "candidate" })]));

    // A silently empty address set would stream a plausible-looking empty result.
    expect(() => substreamsParams(parsed)).toThrow(/no listed vaults/i);
  });
});

describe("curated Base USDC manifest", () => {
  it("parses the committed manifest through the domain schema", () => {
    expect(baseUsdcVaultManifest.chainId).toBe(8453);
    expect(baseUsdcVaultManifest.vaults.length).toBeGreaterThanOrEqual(3);
  });

  it("spans at least two protocols, as the MVP scope requires", () => {
    const protocols = new Set(listedVaults(baseUsdcVaultManifest).map((v) => v.protocolSlug));

    expect(protocols.size).toBeGreaterThanOrEqual(2);
  });

  it("pins every listed vault to the same observation window", () => {
    const starts = new Set(listedVaults(baseUsdcVaultManifest).map((v) => v.windowStartBlock));

    // A drifting start block would make the comparison between vaults dishonest.
    expect(starts.size).toBe(1);
  });

  it("carries real verification evidence for every listed vault", () => {
    for (const vault of listedVaults(baseUsdcVaultManifest)) {
      expect(vault.evidence.codeHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(vault.evidence.latestProbes.length).toBe(9);
      expect(vault.evidence.historicalProbes.length).toBe(9);
      expect(Date.parse(vault.evidence.verifiedAt)).not.toBeNaN();
    }
  });

  it("renders a params string the Rust module can parse", () => {
    const params = substreamsParams(baseUsdcVaultManifest);

    expect(params).toMatch(/^chain_id=8453&anchor_block=\d+&checkpoint_interval=\d+&vaults=/);
    // Addresses must be lowercase and unprefixed for raw byte comparison in the module.
    expect(params).not.toMatch(/vaults=.*0x/);
    expect(params).toBe(params.toLowerCase());
  });
});
