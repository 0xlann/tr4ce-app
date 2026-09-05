import { callErrorsSchema, type CallError } from "@tr4ce/domain";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { reorgInvalidationId, vaultFlowId, vaultSnapshotId } from "../ids.js";
import { hexToBytes } from "../schema/columns.js";
import {
  evidenceReport,
  reorgInvalidation,
  reportObservation,
  vaultFlow,
  vaultSnapshot,
} from "../schema/observations.js";
import { rawDeposit, rawShareTransfer, rawVaultSnapshot, rawWithdraw } from "../schema/raw.js";
import { resolveCapabilityAt, type VaultLookup, type VaultLookupEntry } from "./vaults.js";

/**
 * Promotion of confirmed raw rows into the constrained application tables, and the deep-reorg
 * path that undoes a promotion after the fact.
 *
 * The one invariant everything else follows from: this module never reads a raw row above the
 * confirmed head. Anything the sink might still undo has therefore never been promoted, which is
 * what keeps the sink's reorg handling and the application's foreign keys out of each other's way.
 */

/** A raw batch carried a schema version the consumer does not implement. */
export class SchemaVersionError extends Error {
  constructor(readonly found: readonly string[], readonly accepted: readonly string[]) {
    super(
      `Raw rows carry unsupported schema version(s) ${found.join(", ")}; this consumer accepts ${accepted.join(", ")}.`,
    );
    this.name = "SchemaVersionError";
  }
}

/** A raw row names an address the registry has never verified. */
export class UnknownVaultError extends Error {
  constructor(readonly addresses: readonly string[]) {
    super(`Raw rows reference unregistered vault address(es): ${addresses.join(", ")}.`);
    this.name = "UnknownVaultError";
  }
}

/** A snapshot fell outside every capability window for its vault. */
export class CapabilityResolutionError extends Error {
  constructor(readonly vaultAddress: string, readonly blockNumber: number) {
    super(
      `No capability profile covers vault ${vaultAddress} at block ${blockNumber}; refusing to promote a snapshot with no interpretation.`,
    );
    this.name = "CapabilityResolutionError";
  }
}

export interface PromoteRangeOptions {
  chainId: number;
  /** Inclusive. */
  fromBlock: number;
  /** Inclusive, and never above the confirmed head — the caller is responsible for that bound. */
  toBlock: number;
  lookup: VaultLookup;
  /** Producer schema versions this consumer knows how to read. */
  acceptedSchemaVersions: readonly string[];
}

export interface PromoteRangeResult {
  deposits: number;
  withdrawals: number;
  shareTransfers: number;
  snapshots: number;
  /** Highest block that actually produced a promoted row, with its hash. Null when none did. */
  attested: { blockNumber: number; blockHash: string; schemaVersion: string } | null;
}

interface RawEventRow {
  chainId: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  vault: string;
  schemaVersion: string;
}

/**
 * Copy every confirmed raw row in `[fromBlock, toBlock]` into the application tables.
 *
 * Runs inside the caller's transaction so the rows and the cursor commit together. Validation is
 * up front and throws: a rejected batch must leave the cursor exactly where it was, so the next
 * run reprocesses the same range rather than stepping over it (ARCHITECTURE.md section 9).
 */
export async function promoteRange(
  tx: Executor,
  options: PromoteRangeOptions,
): Promise<PromoteRangeResult> {
  const { chainId, fromBlock, toBlock, lookup, acceptedSchemaVersions } = options;

  if (toBlock < fromBlock) {
    return { deposits: 0, withdrawals: 0, shareTransfers: 0, snapshots: 0, attested: null };
  }

  const deposits = await tx
    .select()
    .from(rawDeposit)
    .where(
      and(
        eq(rawDeposit.chainId, chainId),
        gte(rawDeposit.blockNumber, fromBlock),
        lte(rawDeposit.blockNumber, toBlock),
      ),
    );

  const withdrawals = await tx
    .select()
    .from(rawWithdraw)
    .where(
      and(
        eq(rawWithdraw.chainId, chainId),
        gte(rawWithdraw.blockNumber, fromBlock),
        lte(rawWithdraw.blockNumber, toBlock),
      ),
    );

  const transfers = await tx
    .select()
    .from(rawShareTransfer)
    .where(
      and(
        eq(rawShareTransfer.chainId, chainId),
        gte(rawShareTransfer.blockNumber, fromBlock),
        lte(rawShareTransfer.blockNumber, toBlock),
      ),
    );

  const snapshots = await tx
    .select()
    .from(rawVaultSnapshot)
    .where(
      and(
        eq(rawVaultSnapshot.chainId, chainId),
        gte(rawVaultSnapshot.blockNumber, fromBlock),
        lte(rawVaultSnapshot.blockNumber, toBlock),
      ),
    );

  const allRows: RawEventRow[] = [...deposits, ...withdrawals, ...transfers];
  const everything = [...allRows, ...snapshots];

  assertSchemaVersions(everything, acceptedSchemaVersions);
  assertKnownVaults(everything, lookup);

  let attested: PromoteRangeResult["attested"] = null;

  const attest = (blockNumber: number, blockHash: string, schemaVersion: string) => {
    if (attested === null || blockNumber > attested.blockNumber) {
      attested = { blockNumber, blockHash, schemaVersion };
    }
  };

  for (const row of deposits) {
    const entry = lookup.get(row.vault.toLowerCase())!;

    await upsertFlow(tx, {
      row,
      entry,
      kind: "deposit",
      transferKind: null,
      sender: row.sender,
      owner: row.owner,
      receiver: null,
      assets: row.assets,
      shares: row.shares,
    });

    attest(row.blockNumber, row.blockHash, row.schemaVersion);
  }

  for (const row of withdrawals) {
    const entry = lookup.get(row.vault.toLowerCase())!;

    await upsertFlow(tx, {
      row,
      entry,
      kind: "withdraw",
      transferKind: null,
      sender: row.sender,
      owner: row.owner,
      receiver: row.receiver,
      assets: row.assets,
      shares: row.shares,
    });

    attest(row.blockNumber, row.blockHash, row.schemaVersion);
  }

  for (const row of transfers) {
    const entry = lookup.get(row.vault.toLowerCase())!;

    await upsertFlow(tx, {
      row,
      entry,
      kind: "share_transfer",
      transferKind: row.transferKind,
      sender: row.fromAddress,
      owner: row.fromAddress,
      receiver: row.toAddress,
      // A share transfer moves no assets. Null, never zero: zero would read as a transfer that
      // moved value and happened to be worth nothing.
      assets: null,
      shares: row.shares,
    });

    attest(row.blockNumber, row.blockHash, row.schemaVersion);
  }

  for (const row of snapshots) {
    const entry = lookup.get(row.vault.toLowerCase())!;
    const capabilityId = resolveCapabilityAt(entry, BigInt(row.blockNumber));

    if (capabilityId === null) {
      throw new CapabilityResolutionError(row.vault, row.blockNumber);
    }

    const callErrors = parseCallErrors(row.callErrors);
    const id = vaultSnapshotId(chainId, row.vault, row.blockHash, row.schemaVersion);

    const values = {
      capabilityId,
      blockNumber: String(row.blockNumber),
      blockTime: row.blockTime,
      // Nullable on the way in and nullable on the way out. No COALESCE anywhere on this path:
      // the raw schema's promise that NULL never means zero has to survive the INSERT.
      totalAssets: row.totalAssets,
      totalSupply: row.totalSupply,
      oneShareUnits: row.oneShareUnits,
      oneShareAssets: row.oneShareAssets,
      // A non-ok status is promoted, not filtered. ARCHITECTURE.md section 9 makes a reverted read
      // persist its classification so the dependent rule becomes UNKNOWN; dropping the row would
      // make missing evidence invisible instead of explicit.
      callStatus: row.callStatus,
      callErrors,
      triggerActivity: row.triggerActivity,
      triggerCheckpoint: row.triggerCheckpoint,
      triggerAnchor: row.triggerAnchor,
      schemaVersion: row.schemaVersion,
    };

    await tx
      .insert(vaultSnapshot)
      .values({
        id,
        vaultId: entry.id,
        chainId,
        blockHash: hexToBytes(row.blockHash),
        ...values,
      })
      // `canonical` and `observed_at` are deliberately absent from the update set: re-promoting a
      // row must not resurrect an observation a deep reorg already marked orphaned, and must not
      // rewrite when it was first seen.
      .onConflictDoUpdate({ target: vaultSnapshot.id, set: values });

    attest(row.blockNumber, row.blockHash, row.schemaVersion);
  }

  return {
    deposits: deposits.length,
    withdrawals: withdrawals.length,
    shareTransfers: transfers.length,
    snapshots: snapshots.length,
    attested,
  };
}

interface FlowUpsert {
  row: RawEventRow;
  entry: VaultLookupEntry;
  kind: "deposit" | "withdraw" | "share_transfer";
  transferKind: string | null;
  sender: string | null;
  owner: string | null;
  receiver: string | null;
  assets: string | null;
  shares: string;
}

async function upsertFlow(tx: Executor, input: FlowUpsert): Promise<void> {
  const { row, entry } = input;
  const id = vaultFlowId(row.chainId, row.blockHash, row.transactionHash, row.logIndex, input.kind);

  const values = {
    blockNumber: String(row.blockNumber),
    blockTime: row.blockTime,
    transferKind: input.transferKind,
    sender: input.sender === null ? null : hexToBytes(input.sender),
    owner: input.owner === null ? null : hexToBytes(input.owner),
    receiver: input.receiver === null ? null : hexToBytes(input.receiver),
    assets: input.assets,
    shares: input.shares,
    schemaVersion: row.schemaVersion,
  };

  await tx
    .insert(vaultFlow)
    .values({
      id,
      vaultId: entry.id,
      chainId: row.chainId,
      blockHash: hexToBytes(row.blockHash),
      transactionHash: hexToBytes(row.transactionHash),
      logIndex: row.logIndex,
      kind: input.kind,
      ...values,
    })
    // As with snapshots: `canonical` and `promoted_at` stay out of the update set.
    .onConflictDoUpdate({ target: vaultFlow.id, set: values });
}

function assertSchemaVersions(
  rows: readonly { schemaVersion: string }[],
  accepted: readonly string[],
): void {
  const found = [...new Set(rows.map((row) => row.schemaVersion))];
  const unsupported = found.filter((version) => !accepted.includes(version));

  if (unsupported.length > 0) {
    throw new SchemaVersionError(unsupported, accepted);
  }
}

function assertKnownVaults(rows: readonly { vault: string }[], lookup: VaultLookup): void {
  const unknown = [
    ...new Set(rows.map((row) => row.vault.toLowerCase()).filter((address) => !lookup.has(address))),
  ];

  if (unknown.length > 0) {
    throw new UnknownVaultError(unknown);
  }
}

/**
 * Raw staging stores `call_errors` as TEXT because the Database Changes sink emits a JSONB value
 * unquoted and produces a syntax error. Parse and validate it here, once, on the way into the
 * JSONB column the ERD asks for.
 */
function parseCallErrors(raw: string): CallError[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Raw snapshot carries unparseable call_errors: ${String(error)}`);
  }

  return callErrorsSchema.parse(parsed);
}

// -----------------------------------------------------------------------------------------------
// Deep reorg
// -----------------------------------------------------------------------------------------------

export interface OrphanedBlock {
  blockNumber: number;
  orphanedBlockHash: string;
  canonicalBlockHash: string;
}

export interface PromotedBlockHash {
  blockNumber: number;
  blockHash: string;
}

/**
 * Every distinct block hash promoted at or above `fromBlock`.
 *
 * This is the input to reorg reconciliation: the worker asks the chain what hash each of these
 * block numbers actually has now, and anything that disagrees was promoted from a block that no
 * longer exists.
 */
export async function listPromotedBlockHashes(
  tx: Executor,
  chainId: number,
  fromBlock: number,
): Promise<PromotedBlockHash[]> {
  const rows = await tx.execute<{ block_number: string; block_hash: string }>(sql`
    SELECT block_number, encode(block_hash, 'hex') AS block_hash
      FROM vault_snapshot
     WHERE chain_id = ${chainId} AND canonical AND block_number >= ${String(fromBlock)}
     UNION
    SELECT block_number, encode(block_hash, 'hex') AS block_hash
      FROM vault_flow
     WHERE chain_id = ${chainId} AND canonical AND block_number >= ${String(fromBlock)}
     ORDER BY block_number
  `);

  return [...rows].map((row) => ({
    blockNumber: Number(row.block_number),
    blockHash: `0x${row.block_hash}`,
  }));
}

export interface InvalidationResult {
  flows: number;
  snapshots: number;
  reports: number;
}

/**
 * Mark everything promoted from an orphaned block non-canonical, and invalidate every report that
 * cites it.
 *
 * Nothing is deleted. ERD section 11 makes invalidation append/audit state: the orphaned rows stay,
 * flipped to `canonical = false`, and each subject gains a `reorg_invalidation` row recording the
 * hash that was believed and the hash that replaced it. A report whose evidence was orphaned stays
 * readable and stays cited — it simply stops being canonical, which is what lets a user see that
 * an answer they were given has since been withdrawn, and why.
 */
export async function invalidateOrphanedBlock(
  tx: Executor,
  chainId: number,
  orphan: OrphanedBlock,
): Promise<InvalidationResult> {
  const orphanedHash = hexToBytes(orphan.orphanedBlockHash);
  const blockNumber = String(orphan.blockNumber);

  const orphanedFlows = await tx
    .select({ id: vaultFlow.id })
    .from(vaultFlow)
    .where(
      and(
        eq(vaultFlow.chainId, chainId),
        eq(vaultFlow.blockNumber, blockNumber),
        eq(vaultFlow.blockHash, orphanedHash),
        eq(vaultFlow.canonical, true),
      ),
    );

  const orphanedSnapshots = await tx
    .select({ id: vaultSnapshot.id })
    .from(vaultSnapshot)
    .where(
      and(
        eq(vaultSnapshot.chainId, chainId),
        eq(vaultSnapshot.blockNumber, blockNumber),
        eq(vaultSnapshot.blockHash, orphanedHash),
        eq(vaultSnapshot.canonical, true),
      ),
    );

  const flowIds = orphanedFlows.map((row) => row.id);
  const snapshotIds = orphanedSnapshots.map((row) => row.id);

  if (flowIds.length > 0) {
    await tx.update(vaultFlow).set({ canonical: false }).where(inArray(vaultFlow.id, flowIds));
  }

  if (snapshotIds.length > 0) {
    await tx
      .update(vaultSnapshot)
      .set({ canonical: false })
      .where(inArray(vaultSnapshot.id, snapshotIds));
  }

  // Dependents are found through the citation table, not by block number: a report is invalidated
  // because it rests on an orphaned observation, not because it happens to sit near one.
  const dependents =
    flowIds.length + snapshotIds.length === 0
      ? []
      : await tx
          .selectDistinct({ id: evidenceReport.id })
          .from(evidenceReport)
          .innerJoin(reportObservation, eq(reportObservation.reportId, evidenceReport.id))
          .where(
            and(
              eq(evidenceReport.canonical, true),
              flowIds.length > 0 && snapshotIds.length > 0
                ? sql`(${inArray(reportObservation.vaultFlowId, flowIds)} OR ${inArray(reportObservation.vaultSnapshotId, snapshotIds)})`
                : flowIds.length > 0
                  ? inArray(reportObservation.vaultFlowId, flowIds)
                  : inArray(reportObservation.vaultSnapshotId, snapshotIds),
            ),
          );

  const reportIds = dependents.map((row) => row.id);

  if (reportIds.length > 0) {
    await tx
      .update(evidenceReport)
      .set({
        canonical: false,
        invalidatedAt: new Date(),
        invalidationReason: "REORG_INVALIDATED",
      })
      .where(inArray(evidenceReport.id, reportIds));
  }

  const audit = [
    ...flowIds.map((id) => ({ kind: "vault_flow" as const, id })),
    ...snapshotIds.map((id) => ({ kind: "vault_snapshot" as const, id })),
    ...reportIds.map((id) => ({ kind: "evidence_report" as const, id })),
  ];

  if (audit.length > 0) {
    await tx
      .insert(reorgInvalidation)
      .values(
        audit.map((subject) => ({
          id: reorgInvalidationId(subject.kind, subject.id, orphan.canonicalBlockHash),
          chainId,
          blockNumber,
          orphanedBlockHash: orphanedHash,
          canonicalBlockHash: hexToBytes(orphan.canonicalBlockHash),
          subjectKind: subject.kind,
          subjectId: subject.id,
          reasonCode: "REORG_INVALIDATED",
        })),
      )
      // Re-running reconciliation over the same orphan appends nothing new; the audit row already
      // records that this subject was invalidated by this replacement.
      .onConflictDoNothing({ target: reorgInvalidation.id });
  }

  return { flows: flowIds.length, snapshots: snapshotIds.length, reports: reportIds.length };
}
