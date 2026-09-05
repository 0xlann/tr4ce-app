import { createHash } from "node:crypto";

/**
 * Deterministic surrogate keys.
 *
 * The ERD gives registry and observation rows `uuid` primary keys, but promotion has to be
 * idempotent: replaying the same raw block range must produce byte-identical application rows,
 * not merely rows that agree once you look past a random identifier. A random v4 key would make
 * every replay assertion ignore the primary key, which is precisely the column a bug would show
 * up in. Deriving the uuid from the row's natural key removes that blind spot.
 *
 * Idempotency itself still comes from `ON CONFLICT` on the natural UNIQUE key declared in the
 * migration; these ids make the result comparable, they do not enforce it.
 *
 * RFC 4122 version 5 (SHA-1, name-based). Version 5 is used for its defined derivation, not for
 * any security property.
 */

/** Namespace UUID for TR4CE-derived identifiers. Fixed forever; changing it re-keys the database. */
const TR4CE_NAMESPACE = "6f1f2d6c-9d4f-5c2a-a8d3-0b7a5e4c1f90";

function namespaceBytes(namespace: string): Uint8Array {
  const hex = namespace.replaceAll("-", "");
  const bytes = new Uint8Array(16);

  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

const NAMESPACE_BYTES = namespaceBytes(TR4CE_NAMESPACE);

function uuidV5(name: string): string {
  const digest = createHash("sha1").update(NAMESPACE_BYTES).update(Buffer.from(name, "utf8")).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);

  // Version 5 in the high nibble of octet 6, RFC 4122 variant in the two high bits of octet 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Build the name string a derived id hashes over.
 *
 * Addresses and hashes are lowercased so a checksummed and an unchecksummed spelling of the same
 * address can never produce two rows for one entity.
 */
function name(kind: string, parts: readonly (string | number)[]): string {
  return `tr4ce:${kind}:${parts.map((part) => String(part).toLowerCase()).join(":")}`;
}

export function protocolId(slug: string): string {
  return uuidV5(name("protocol", [slug]));
}

export function assetId(chainId: number, address: string): string {
  return uuidV5(name("asset", [chainId, address]));
}

export function vaultId(chainId: number, address: string): string {
  return uuidV5(name("vault", [chainId, address]));
}

export function vaultCapabilityId(
  vault: string,
  adapterKey: string,
  adapterVersion: string,
  effectiveFromBlock: string,
): string {
  return uuidV5(name("vault_capability", [vault, adapterKey, adapterVersion, effectiveFromBlock]));
}

/**
 * Canonical event identity, per ARCHITECTURE.md section 4.1:
 * `(chain_id, block_hash, transaction_hash, log_index)`, plus the kind so a single log can never
 * be claimed by two flow kinds. Never keyed on transaction hash alone.
 */
export function vaultFlowId(
  chainId: number,
  blockHash: string,
  transactionHash: string,
  logIndex: number,
  kind: string,
): string {
  return uuidV5(name("vault_flow", [chainId, blockHash, transactionHash, logIndex, kind]));
}

export function vaultSnapshotId(
  chainId: number,
  vaultAddress: string,
  blockHash: string,
  schemaVersion: string,
): string {
  return uuidV5(name("vault_snapshot", [chainId, vaultAddress, blockHash, schemaVersion]));
}

export function reportObservationId(reportId: string, observationId: string): string {
  return uuidV5(name("report_observation", [reportId, observationId]));
}

/**
 * Invalidation rows are append-only audit records, so their id includes the detection block hash:
 * a second reorg over the same subject appends a new row rather than overwriting the first.
 */
export function reorgInvalidationId(
  subjectKind: string,
  subjectId: string,
  canonicalBlockHash: string,
): string {
  return uuidV5(name("reorg_invalidation", [subjectKind, subjectId, canonicalBlockHash]));
}
