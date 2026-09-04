import { vaultManifestSchema, type CuratedVault, type VaultManifest } from "@tr4ce/domain";

import rawManifest from "./manifest.json" with { type: "json" };

/**
 * Curated USDC vaults on Base, each one verified on chain by
 * `scripts/verify-vault.sh` before being listed here.
 */
export const baseUsdcVaultManifest: VaultManifest = vaultManifestSchema.parse(rawManifest);

/**
 * Validate a curated vault manifest.
 *
 * The manifest is an event-period source artifact: it records the outcome of the ten-step
 * onboarding gate in docs/technical/INTEGRATIONS.md section 4 against live chain state. It is not
 * configuration, and it is never populated from anything but a verification run.
 */
export function parseManifest(raw: unknown): VaultManifest {
  return vaultManifestSchema.parse(raw);
}

/** Vaults that passed the full gate and may back a published evidence report. */
export function listedVaults(manifest: VaultManifest): CuratedVault[] {
  return manifest.vaults.filter((vault) => vault.status === "listed");
}

/**
 * Render the `params` string consumed by the `tr4ce_erc4626` Substreams modules.
 *
 * This is the single source of truth for the curated address set: the Rust module compiles in no
 * addresses at all. The format is mirrored by `Config::parse` in substreams/erc4626/src/config.rs,
 * and addresses are lowercased because the module compares raw bytes, never formatted strings.
 */
export function substreamsParams(manifest: VaultManifest): string {
  const vaults = listedVaults(manifest);

  if (vaults.length === 0) {
    throw new Error("Manifest contains no listed vaults; refusing to build an empty params string.");
  }

  const anchorBlock = vaults
    .map((vault) => BigInt(vault.windowStartBlock))
    .reduce((lowest, candidate) => (candidate < lowest ? candidate : lowest));

  const entries = vaults
    .map((vault) =>
      [
        vault.address.slice(2).toLowerCase(),
        vault.asset.slice(2).toLowerCase(),
        String(vault.shareDecimals),
        String(vault.assetDecimals),
      ].join(":"),
    )
    .join(",");

  return [
    `chain_id=${manifest.chainId}`,
    `anchor_block=${anchorBlock}`,
    `checkpoint_interval=${manifest.snapshotCheckpointBlocks}`,
    `vaults=${entries}`,
  ].join("&");
}
