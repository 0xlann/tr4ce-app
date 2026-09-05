import type { CuratedVault, VaultManifest } from "@tr4ce/domain";
import { eq } from "drizzle-orm";

import type { Executor } from "../client.js";
import { assetId, protocolId, vaultCapabilityId, vaultId } from "../ids.js";
import { bytesToHex, hexToBytes } from "../schema/columns.js";
import { asset, network, protocol, vault, vaultCapability } from "../schema/registry.js";

/**
 * Registry seeding.
 *
 * The manifest is the only source. It is an event-period artifact recording the outcome of the
 * ten-step onboarding gate against live chain state, so seeding is a transcription step, not a
 * discovery step: nothing is fetched, inferred, or defaulted here.
 */

export interface NetworkSeed {
  chainId: number;
  slug: string;
  name: string;
  nativeSymbol: string;
  /**
   * How far below the RPC head a block must be before its rows may be promoted. Stored per network
   * rather than hardcoded, because it is an operational setting that differs by chain.
   */
  confirmationDepth: number;
}

/** Display metadata for a protocol. Never used for identity; the curated address decides that. */
export interface ProtocolSeed {
  slug: string;
  name: string;
  documentationUrl: string | null;
}

export interface SeedRegistryOptions {
  manifest: VaultManifest;
  network: NetworkSeed;
  protocols: readonly ProtocolSeed[];
}

export interface SeedRegistryResult {
  protocols: number;
  assets: number;
  vaults: number;
  capabilities: number;
}

/**
 * Which vault a curated address maps to, plus everything promotion needs to attribute a raw row.
 * Keyed by lowercase unprefixed-free `0x` address, because raw staging stores addresses as text
 * and a checksummed spelling must never produce a second entry.
 */
export interface VaultLookupEntry {
  id: string;
  chainId: number;
  address: string;
  shareDecimals: number;
  capabilities: CapabilityWindow[];
}

export interface CapabilityWindow {
  id: string;
  /** Inclusive. */
  effectiveFromBlock: bigint;
  /** Exclusive; null while this is the open profile. */
  effectiveToBlock: bigint | null;
}

export type VaultLookup = ReadonlyMap<string, VaultLookupEntry>;

/**
 * Seed or refresh the registry from a verified manifest.
 *
 * Idempotent by construction: every surrogate key is derived from the row's natural key, so a
 * second run updates the same rows instead of inserting duplicates.
 */
export async function seedRegistry(
  tx: Executor,
  { manifest, network: networkSeed, protocols }: SeedRegistryOptions,
): Promise<SeedRegistryResult> {
  if (networkSeed.chainId !== manifest.chainId) {
    throw new Error(
      `Network seed is for chain ${networkSeed.chainId} but the manifest describes chain ${manifest.chainId}.`,
    );
  }

  const now = new Date();

  await tx
    .insert(network)
    .values({
      chainId: networkSeed.chainId,
      slug: networkSeed.slug,
      name: networkSeed.name,
      nativeSymbol: networkSeed.nativeSymbol,
      confirmationDepth: networkSeed.confirmationDepth,
      enabled: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: network.chainId,
      set: {
        slug: networkSeed.slug,
        name: networkSeed.name,
        nativeSymbol: networkSeed.nativeSymbol,
        confirmationDepth: networkSeed.confirmationDepth,
        updatedAt: now,
      },
    });

  const referencedSlugs = new Set(manifest.vaults.map((entry) => entry.protocolSlug));
  const missing = [...referencedSlugs].filter(
    (slug) => !protocols.some((candidate) => candidate.slug === slug),
  );

  if (missing.length > 0) {
    throw new Error(`Manifest references protocols with no seed entry: ${missing.join(", ")}.`);
  }

  const usedProtocols = protocols.filter((entry) => referencedSlugs.has(entry.slug));

  for (const entry of usedProtocols) {
    // adapter_key comes from the manifest rather than the seed: the code adapter a vault is read
    // with is verified evidence, not display configuration.
    const adapterKey = manifest.vaults.find((candidate) => candidate.protocolSlug === entry.slug)
      ?.adapterKey;

    if (adapterKey === undefined) {
      throw new Error(`No manifest vault carries protocol ${entry.slug}.`);
    }

    await tx
      .insert(protocol)
      .values({
        id: protocolId(entry.slug),
        slug: entry.slug,
        name: entry.name,
        adapterKey,
        documentationUrl: entry.documentationUrl,
      })
      .onConflictDoUpdate({
        target: protocol.id,
        set: { name: entry.name, adapterKey, documentationUrl: entry.documentationUrl },
      });
  }

  for (const canonical of manifest.canonicalAssets) {
    await tx
      .insert(asset)
      .values({
        id: assetId(canonical.chainId, canonical.address),
        chainId: canonical.chainId,
        address: hexToBytes(canonical.address),
        symbol: canonical.canonicalKey,
        name: null,
        decimals: canonical.decimals,
        canonicalKey: canonical.canonicalKey,
        verifiedAtBlock: null,
        codeHash: null,
      })
      .onConflictDoUpdate({
        target: asset.id,
        set: { decimals: canonical.decimals, canonicalKey: canonical.canonicalKey },
      });
  }

  let capabilities = 0;

  for (const entry of manifest.vaults) {
    const id = vaultId(entry.chainId, entry.address);
    const linkedAsset = manifest.canonicalAssets.find(
      (candidate) => candidate.address.toLowerCase() === entry.asset.toLowerCase(),
    );

    if (linkedAsset === undefined) {
      throw new Error(
        `Vault ${entry.address} names asset ${entry.asset}, which is not a canonical asset in the manifest.`,
      );
    }

    await tx
      .insert(vault)
      .values({
        id,
        chainId: entry.chainId,
        address: hexToBytes(entry.address),
        protocolId: protocolId(entry.protocolSlug),
        assetId: assetId(linkedAsset.chainId, linkedAsset.address),
        shareDecimals: entry.shareDecimals,
        name: entry.name,
        symbol: entry.symbol,
        deploymentBlock: entry.deploymentBlock,
        codeHash: hexToBytes(entry.evidence.codeHash),
        status: entry.status,
        statusReason: entry.statusReason,
        verifiedAt: new Date(entry.evidence.verifiedAt),
      })
      .onConflictDoUpdate({
        target: vault.id,
        set: {
          shareDecimals: entry.shareDecimals,
          name: entry.name,
          symbol: entry.symbol,
          deploymentBlock: entry.deploymentBlock,
          codeHash: hexToBytes(entry.evidence.codeHash),
          status: entry.status,
          statusReason: entry.statusReason,
          verifiedAt: new Date(entry.evidence.verifiedAt),
        },
      });

    await seedCapability(tx, id, entry);
    capabilities += 1;
  }

  return {
    protocols: usedProtocols.length,
    assets: manifest.canonicalAssets.length,
    vaults: manifest.vaults.length,
    capabilities,
  };
}

/**
 * Open one capability profile per vault, effective from the declared observation window start.
 *
 * `effective_from_block` is the window start rather than the deployment block because the window
 * start is the block the probes actually ran against. Claiming the profile held at deployment
 * would assert something the verification run never checked.
 */
async function seedCapability(tx: Executor, id: string, entry: CuratedVault): Promise<void> {
  const capabilityId = vaultCapabilityId(
    id,
    entry.adapterKey,
    entry.adapterVersion,
    entry.windowStartBlock,
  );

  const capabilities = {
    adapterKey: entry.adapterKey,
    adapterVersion: entry.adapterVersion,
    rpcProviderKey: entry.evidence.rpcProviderKey,
    verifiedAt: entry.evidence.verifiedAt,
    // Both probe sets are kept verbatim. A method that reverted at the window start but answers
    // now is a real difference in what the vault supported when, and collapsing them into one
    // "supported" flag would erase it.
    latestProbes: entry.evidence.latestProbes,
    historicalProbes: entry.evidence.historicalProbes,
  };

  await tx
    .insert(vaultCapability)
    .values({
      id: capabilityId,
      vaultId: id,
      adapterKey: entry.adapterKey,
      adapterVersion: entry.adapterVersion,
      implementationAddress:
        entry.evidence.implementationAddress === null
          ? null
          : hexToBytes(entry.evidence.implementationAddress),
      implementationCodeHash:
        entry.evidence.implementationCodeHash === null
          ? null
          : hexToBytes(entry.evidence.implementationCodeHash),
      capabilities,
      effectiveFromBlock: entry.windowStartBlock,
      effectiveToBlock: null,
      verifiedAt: new Date(entry.evidence.verifiedAt),
    })
    // A profile's interpretation is immutable once a report cites it, so a re-seed of the same
    // profile must not rewrite it. Only the audit timestamp and the probe evidence move.
    .onConflictDoNothing({ target: vaultCapability.id });
}

/**
 * Read a network's operational settings.
 *
 * The promotion worker reads `confirmation_depth` through this rather than importing a constant:
 * the depth is a property of the chain's reorg behaviour and belongs in a row that can change
 * without a deploy.
 */
export async function readNetwork(
  tx: Executor,
  chainId: number,
): Promise<{ chainId: number; slug: string; confirmationDepth: number; enabled: boolean } | null> {
  const [row] = await tx
    .select({
      chainId: network.chainId,
      slug: network.slug,
      confirmationDepth: network.confirmationDepth,
      enabled: network.enabled,
    })
    .from(network)
    .where(eq(network.chainId, chainId))
    .limit(1);

  return row ?? null;
}

/**
 * Load every listed vault with its capability windows, keyed by lowercase address.
 *
 * Promotion resolves raw addresses through this map. A raw row naming an address that is not here
 * is a hard failure, not a row to skip: it means the sink is streaming a vault set the registry
 * has never verified.
 */
export async function loadVaultLookup(tx: Executor, chainId: number): Promise<VaultLookup> {
  const rows = await tx
    .select({
      id: vault.id,
      chainId: vault.chainId,
      address: vault.address,
      shareDecimals: vault.shareDecimals,
    })
    .from(vault)
    .where(eq(vault.chainId, chainId));

  const capabilityRows = await tx
    .select({
      id: vaultCapability.id,
      vaultId: vaultCapability.vaultId,
      effectiveFromBlock: vaultCapability.effectiveFromBlock,
      effectiveToBlock: vaultCapability.effectiveToBlock,
    })
    .from(vaultCapability);

  const byVault = new Map<string, CapabilityWindow[]>();

  for (const row of capabilityRows) {
    const windows = byVault.get(row.vaultId) ?? [];

    windows.push({
      id: row.id,
      effectiveFromBlock: BigInt(row.effectiveFromBlock),
      effectiveToBlock: row.effectiveToBlock === null ? null : BigInt(row.effectiveToBlock),
    });

    byVault.set(row.vaultId, windows);
  }

  const lookup = new Map<string, VaultLookupEntry>();

  for (const row of rows) {
    const address = bytesToHex(row.address);

    lookup.set(address, {
      id: row.id,
      chainId: row.chainId,
      address,
      shareDecimals: row.shareDecimals,
      capabilities: byVault.get(row.id) ?? [],
    });
  }

  return lookup;
}

/**
 * Find the capability profile in force at a block.
 *
 * Returns null when no profile covers it. The caller must treat that as a failure rather than
 * storing the snapshot with a null interpretation: a snapshot whose reads cannot be interpreted is
 * not evidence, and pretending otherwise is how a wrong number reaches a report.
 */
export function resolveCapabilityAt(entry: VaultLookupEntry, blockNumber: bigint): string | null {
  for (const window of entry.capabilities) {
    const startsAtOrBefore = window.effectiveFromBlock <= blockNumber;
    const endsAfter = window.effectiveToBlock === null || blockNumber < window.effectiveToBlock;

    if (startsAtOrBefore && endsAfter) {
      return window.id;
    }
  }

  return null;
}
