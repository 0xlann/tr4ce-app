import {
  findVaultDetail,
  listVaultDetails,
  readApplicationCursor,
  type Database,
  type VaultDetail,
} from "@tr4ce/db";
import { capabilityProbeSchema, vaultIdentitySchema, type CapabilityProbe } from "@tr4ce/domain";

import { vaultSummarySchema, type VaultSummary } from "../contract.js";
import { ApiFailure } from "../errors.js";

/**
 * The curated registry, as the API sees it.
 *
 * Everything here comes from promoted rows. A vault the registry has never heard of is a request
 * error, not a gap in our observations, and the two carry different codes for exactly that reason.
 */

export interface VaultRegistryEntry {
  vaultId: string;
  chainId: number;
  address: string;
  assetAddress: string;
  assetCanonicalKey: string | null;
  deploymentBlock: string | null;
  probes: readonly CapabilityProbe[];
  /** The open capability profile, which a simulation binds to (SMART-CONTRACT.md section 6). */
  adapterKey: string;
  adapterVersion: string;
  /** Highest block the promotion worker has attested to. Null before the first promotion. */
  attestedBlock: string | null;
  /** Nominal block time, used only to estimate where a window opens. */
  blockSeconds: number;
}

export interface RegistryOptions {
  db: Database;
  streamKey: string;
  /** Base produces a block roughly every two seconds. Only ever used for an estimate. */
  blockSeconds: number;
}

export async function listVaults(
  options: RegistryOptions,
  chainId: number,
): Promise<VaultSummary[]> {
  const rows = await listVaultDetails(options.db, chainId);

  return rows.map((row) => toSummary(row));
}

export async function requireVault(
  options: RegistryOptions,
  chainId: number,
  address: string,
): Promise<VaultRegistryEntry> {
  const detail = await findVaultDetail(options.db, chainId, address);

  if (detail === null) {
    throw new ApiFailure(
      "UNKNOWN_VAULT",
      404,
      `${address} is not a curated vault on chain ${chainId}.`,
      { reasonCodes: ["UNSUPPORTED_VAULT"] },
    );
  }

  const cursor = await readApplicationCursor(options.db, chainId, options.streamKey);

  return {
    vaultId: detail.id,
    chainId,
    address: detail.address,
    assetAddress: detail.assetAddress,
    assetCanonicalKey: detail.assetCanonicalKey,
    deploymentBlock: detail.deploymentBlock,
    probes: parseProbes(detail.capabilities),
    adapterKey: detail.adapterKey ?? "unresolved",
    adapterVersion: detail.adapterVersion ?? "unresolved",
    attestedBlock: cursor === null ? null : String(cursor.blockNumber),
    blockSeconds: options.blockSeconds,
  };
}

/** The identity the evidence engine records on a report. Parsed, so a bad row fails here. */
export function identityOf(entry: VaultRegistryEntry) {
  return vaultIdentitySchema.parse({
    chainId: entry.chainId,
    address: entry.address,
    asset: entry.assetAddress,
    assetSymbol: "USDC",
  });
}

function toSummary(row: VaultDetail): VaultSummary {
  return vaultSummarySchema.parse({
    chainId: row.chainId,
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    asset: row.assetAddress,
    assetSymbol: row.assetSymbol,
    shareDecimals: row.shareDecimals,
    status: row.status,
    // A vault with no open profile is still a vault. Saying so beats hiding it or inventing an
    // adapter name that no row supports.
    adapterKey: row.adapterKey ?? "unresolved",
    adapterVersion: row.adapterVersion ?? "unresolved",
  });
}

/**
 * Probe evidence stored on the capability profile.
 *
 * Parsed, not cast: the column is `jsonb` and the row was written by the seeding step, so a shape
 * that no longer matches the contract is a real signal. A row that fails is dropped rather than
 * thrown on — a report can still be built without probe evidence, it simply reports UNKNOWN where
 * the evidence would have been.
 */
function parseProbes(capabilities: unknown): CapabilityProbe[] {
  if (!Array.isArray(capabilities)) {
    return [];
  }

  return capabilities.flatMap((candidate) => {
    const parsed = capabilityProbeSchema.safeParse(candidate);

    return parsed.success ? [parsed.data] : [];
  });
}
