import { and, desc, eq } from "drizzle-orm";

import type { Executor } from "../client.js";
import { bytesToHex, hexToBytes } from "../schema/columns.js";
import { indexerCursor } from "../schema/cursors.js";
import { sinkCursor } from "../schema/raw.js";

/**
 * Two cursors, deliberately not one.
 *
 * The sink's `cursors` table says how far the built-in sink has written into raw staging. The
 * application's `indexer_cursor` says how far the worker has promoted into the constrained tables.
 * Promotion is bounded by both, and by the confirmation depth — see `promotionCeiling`.
 */

export interface ApplicationCursor {
  chainId: number;
  streamKey: string;
  blockNumber: number;
  blockHash: string;
  schemaVersion: string;
  updatedAt: Date;
}

export async function readApplicationCursor(
  tx: Executor,
  chainId: number,
  streamKey: string,
): Promise<ApplicationCursor | null> {
  const [row] = await tx
    .select()
    .from(indexerCursor)
    .where(and(eq(indexerCursor.chainId, chainId), eq(indexerCursor.streamKey, streamKey)))
    .limit(1);

  if (row === undefined) {
    return null;
  }

  return {
    chainId: row.chainId,
    streamKey: row.streamKey,
    blockNumber: Number(row.blockNumber),
    blockHash: bytesToHex(row.blockHash),
    schemaVersion: row.schemaVersion,
    updatedAt: row.updatedAt,
  };
}

export interface WriteCursorInput {
  chainId: number;
  streamKey: string;
  blockNumber: number;
  blockHash: string;
  schemaVersion: string;
}

/**
 * Commit the promotion cursor.
 *
 * Always called inside the same transaction as the rows it covers, so the pair either both land or
 * neither does. A cursor that advanced past rows that failed to commit would silently create a
 * permanent hole in the observation history.
 */
export async function writeApplicationCursor(tx: Executor, input: WriteCursorInput): Promise<void> {
  const values = {
    blockNumber: String(input.blockNumber),
    blockHash: hexToBytes(input.blockHash),
    schemaVersion: input.schemaVersion,
    updatedAt: new Date(),
  };

  await tx
    .insert(indexerCursor)
    .values({ chainId: input.chainId, streamKey: input.streamKey, ...values })
    .onConflictDoUpdate({
      target: [indexerCursor.chainId, indexerCursor.streamKey],
      set: values,
    });
}

/** Rewind after a deep reorg, so the affected range is promoted again from the canonical chain. */
export async function rewindApplicationCursor(
  tx: Executor,
  input: WriteCursorInput,
): Promise<void> {
  await writeApplicationCursor(tx, input);
}

/**
 * How far the built-in sink has actually written.
 *
 * One row per module hash; the highest wins. Promoting past this would promote rows the sink has
 * not committed yet, which is a different failure from promoting unconfirmed rows and is not
 * covered by the confirmation depth.
 */
export async function readSinkHead(tx: Executor): Promise<number | null> {
  const [row] = await tx
    .select({ blockNum: sinkCursor.blockNum })
    .from(sinkCursor)
    .orderBy(desc(sinkCursor.blockNum))
    .limit(1);

  return row === undefined ? null : row.blockNum;
}

export interface PromotionCeilingInput {
  /** Latest block the RPC will answer for. */
  rpcHead: number;
  /** `network.confirmation_depth` for this chain. */
  confirmationDepth: number;
  /** Highest block the sink has committed to raw staging, or null when it has written nothing. */
  sinkHead: number | null;
}

/**
 * The highest block promotion may touch.
 *
 * Both bounds are load-bearing and neither implies the other. `rpcHead - confirmationDepth` alone
 * would let the worker promote blocks the sink has not written; `sinkHead` alone would let it
 * promote rows still inside the window where the sink is allowed to undo them. The lower of the
 * two is the only value where both guarantees hold.
 *
 * Returns null when nothing may be promoted yet.
 */
export function promotionCeiling({
  rpcHead,
  confirmationDepth,
  sinkHead,
}: PromotionCeilingInput): number | null {
  if (sinkHead === null) {
    return null;
  }

  const confirmedHead = rpcHead - confirmationDepth;
  const ceiling = Math.min(confirmedHead, sinkHead);

  return ceiling < 0 ? null : ceiling;
}
