import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";

import type { Executor } from "../client.js";
import { bytesToHex } from "../schema/columns.js";
import { vaultFlow, vaultSnapshot } from "../schema/observations.js";
import { vaultCapability } from "../schema/registry.js";

/**
 * Reading promoted observations back out for the evidence engine.
 *
 * The engine is pure and takes everything as arguments, so this is where a report's raw material
 * is actually chosen. Two decisions live here and nowhere else.
 *
 * The first is which snapshot opens the window. A window of N days is a request, not a guarantee:
 * snapshots exist where the chain gave us one, never at an arbitrary timestamp. The nearest
 * snapshot at or before the requested start is used, and the actual spacing is measured from it —
 * `buildEvidence` reports `elapsedSeconds` rather than assuming N days passed.
 *
 * The second is that only canonical rows are returned. A reorg-invalidated observation stays in the
 * table forever as an audit record, and a report must never be built from one: the creation-time
 * trigger would reject the citation anyway, but failing at the point of selection gives a caller a
 * reason instead of a constraint violation.
 */

/** One promoted snapshot, still in PostgreSQL's decimal-string form. */
export interface SnapshotRow {
  id: string;
  vaultId: string;
  capabilityId: string;
  blockNumber: string;
  blockHash: string;
  blockTime: Date;
  totalAssets: string | null;
  totalSupply: string | null;
  oneShareUnits: string;
  oneShareAssets: string | null;
  callStatus: string;
  schemaVersion: string;
}

export interface FlowRowWithId {
  id: string;
  kind: string;
  transferKind: string | null;
  assets: string | null;
  shares: string;
  canonical: boolean;
}

export interface ObservationWindow {
  /** The latest canonical snapshot at or below `asOfBlock`. Null when the vault has none. */
  end: SnapshotRow | null;
  /**
   * The window's opening snapshot.
   *
   * The latest canonical one at or before the requested start, or — when our index does not reach
   * that far back — the earliest one we hold below the end block. Null only when there is no second
   * snapshot at all.
   */
  start: SnapshotRow | null;
  /**
   * True when `start` is the earliest observation we hold rather than one covering the requested
   * window.
   *
   * The report is still built, over the shorter span it actually measured. Refusing outright would
   * throw away evidence we do have, and the alternative is not silence: `elapsedSeconds` states the
   * real spacing, `limitations` says the window was short, and the history rule reports UNKNOWN
   * because our coverage falls short rather than because the vault is young. A caller is told what
   * was measured; nothing is quoted over a period it was not measured over.
   */
  startIsEarliestAvailable: boolean;
  /** Canonical flows in `(startBlock, endBlock]`, oldest first. */
  flows: FlowRowWithId[];
  /** The capability profile in force at the end block, as the promotion worker resolved it. */
  capability: { id: string; adapterKey: string; adapterVersion: string } | null;
}

export interface ObservationWindowOptions {
  vaultId: string;
  /** Highest block the report may consider. Usually the promotion cursor's attested head. */
  asOfBlock: string;
  /** Lowest block the window's opening snapshot may come from. */
  startBlock: string;
}

export async function readObservationWindow(
  tx: Executor,
  options: ObservationWindowOptions,
): Promise<ObservationWindow> {
  const { vaultId, asOfBlock, startBlock } = options;

  const end = await latestSnapshotAtOrBelow(tx, vaultId, asOfBlock);

  if (end === null) {
    return { end: null, start: null, startIsEarliestAvailable: false, flows: [], capability: null };
  }

  const requested = await latestSnapshotAtOrBelow(tx, vaultId, startBlock);
  // Strictly below the end block: a "start" that is the end snapshot would measure a zero-length
  // window and quote a return computed over no elapsed time at all.
  const start =
    requested ?? (await earliestSnapshotBelow(tx, vaultId, end.blockNumber));
  const startIsEarliestAvailable = requested === null && start !== null;

  const flowRows = await tx
    .select({
      id: vaultFlow.id,
      kind: vaultFlow.kind,
      transferKind: vaultFlow.transferKind,
      assets: vaultFlow.assets,
      shares: vaultFlow.shares,
      canonical: vaultFlow.canonical,
      blockNumber: vaultFlow.blockNumber,
    })
    .from(vaultFlow)
    .where(
      and(
        eq(vaultFlow.vaultId, vaultId),
        eq(vaultFlow.canonical, true),
        // Half-open on the left: the opening snapshot already reflects everything up to and
        // including its own block, so counting that block's flows again would double them.
        // Undefined rather than a zero bound when there is no opening snapshot: drizzle drops the
        // clause, and a lower bound of "0" would read as a deliberate one.
        start === null ? undefined : gte(vaultFlow.blockNumber, nextBlock(start.blockNumber)),
        lte(vaultFlow.blockNumber, end.blockNumber),
      ),
    )
    .orderBy(asc(vaultFlow.blockNumber));

  const capabilityRows = await tx
    .select({
      id: vaultCapability.id,
      adapterKey: vaultCapability.adapterKey,
      adapterVersion: vaultCapability.adapterVersion,
    })
    .from(vaultCapability)
    .where(eq(vaultCapability.id, end.capabilityId));

  return {
    end,
    start,
    startIsEarliestAvailable,
    flows: flowRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      transferKind: row.transferKind,
      assets: row.assets,
      shares: row.shares,
      canonical: row.canonical,
    })),
    capability: capabilityRows[0] ?? null,
  };
}

/** The oldest canonical snapshot strictly below a block. The fallback opening observation. */
async function earliestSnapshotBelow(
  tx: Executor,
  vaultId: string,
  blockNumber: string,
): Promise<SnapshotRow | null> {
  const rows = await tx
    .select(snapshotColumns)
    .from(vaultSnapshot)
    .where(
      and(
        eq(vaultSnapshot.vaultId, vaultId),
        eq(vaultSnapshot.canonical, true),
        lt(vaultSnapshot.blockNumber, blockNumber),
      ),
    )
    .orderBy(asc(vaultSnapshot.blockNumber))
    .limit(1);

  return toSnapshotRow(rows[0]);
}

async function latestSnapshotAtOrBelow(
  tx: Executor,
  vaultId: string,
  blockNumber: string,
): Promise<SnapshotRow | null> {
  const rows = await tx
    .select(snapshotColumns)
    .from(vaultSnapshot)
    .where(
      and(
        eq(vaultSnapshot.vaultId, vaultId),
        eq(vaultSnapshot.canonical, true),
        lte(vaultSnapshot.blockNumber, blockNumber),
      ),
    )
    .orderBy(desc(vaultSnapshot.blockNumber))
    .limit(1);

  return toSnapshotRow(rows[0]);
}

const snapshotColumns = {
  id: vaultSnapshot.id,
  vaultId: vaultSnapshot.vaultId,
  capabilityId: vaultSnapshot.capabilityId,
  blockNumber: vaultSnapshot.blockNumber,
  blockHash: vaultSnapshot.blockHash,
  blockTime: vaultSnapshot.blockTime,
  totalAssets: vaultSnapshot.totalAssets,
  totalSupply: vaultSnapshot.totalSupply,
  oneShareUnits: vaultSnapshot.oneShareUnits,
  oneShareAssets: vaultSnapshot.oneShareAssets,
  callStatus: vaultSnapshot.callStatus,
  schemaVersion: vaultSnapshot.schemaVersion,
} as const;

type SnapshotSelection = { blockHash: Uint8Array } & Omit<SnapshotRow, "blockHash">;

function toSnapshotRow(row: SnapshotSelection | undefined): SnapshotRow | null {
  return row === undefined ? null : { ...row, blockHash: bytesToHex(row.blockHash) };
}

/**
 * The next block as a decimal string.
 *
 * Block numbers are `numeric(78,0)` and arrive as strings, so this goes through `bigint` rather
 * than `Number` — Base is nowhere near 2^53 yet, but a silently rounded block bound would be
 * unfindable if it ever were.
 */
function nextBlock(blockNumber: string): string {
  return (BigInt(blockNumber) + 1n).toString();
}
