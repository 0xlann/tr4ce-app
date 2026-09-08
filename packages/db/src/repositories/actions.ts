import {
  actionStatusSchema,
  revertClassSchema,
  type ActionKind,
  type ActionStatus,
  type RevertClass,
} from "@tr4ce/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { bytesToHex, hexToBytes } from "../schema/columns.js";
import { preparedAction, simulation, transactionReceipt } from "../schema/actions.js";

/**
 * Storing prepared actions and what happened to them.
 *
 * No function here accepts, returns, or has anywhere to put a signature. `recordSubmission` takes a
 * transaction hash the caller reports after their own wallet submitted, which is the only thing
 * TR4CE ever learns about a signed transaction (PRD TR-F-043).
 */

/** The statuses an action can still be signed from, and the ones the live-binding index covers. */
const LIVE_STATUSES = ["prepared", "simulated"] as const;

export interface InsertActionInput {
  actionId: string;
  walletId: string;
  vaultId: string;
  /** Null when no report motivated this action. */
  reportId: string | null;
  kind: ActionKind;
  chainId: number;
  account: string;
  /** The action digest, as 0x-prefixed hex. Covers every call; never the block. */
  calldataHash: string;
  /** The interpretation of this vault's reads the action is bound to. */
  capabilityVersion: string;
  transactions: readonly unknown[];
  /** Shares for a deposit, assets for a redemption. */
  previewed: bigint;
  expiresAt: Date;
}

export interface StoredAction {
  actionId: string;
  status: ActionStatus;
  kind: ActionKind;
  chainId: number;
  vaultId: string;
  account: string;
  capabilityVersion: string;
  transactions: unknown;
  /** How many calls the caller has reported a hash for. */
  sentCount: number;
  previewed: bigint;
  expiresAt: Date;
  invalidatedReason: string | null;
}

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * Store a prepared action, or return the live one already standing under the same digest.
 *
 * Idempotent only while the earlier action is still awaiting a signature. Once it has been sent the
 * same request prepares a *new* action, because by then it is a new intent to spend: the approval
 * TR4CE builds is exact, so a completed deposit leaves the allowance back at zero and a second
 * identical deposit is a second real thing to do. An id derived from the calls would have made that
 * second deposit unpreparable forever.
 */
export async function insertPreparedAction(
  tx: Executor,
  input: InsertActionInput,
): Promise<{ action: StoredAction; created: boolean }> {
  if (input.transactions.length === 0) {
    // An action with no calls is not an action. The CHECK in 0004 refuses it too; this says so
    // before a round trip.
    throw new ActionError(`Action ${input.actionId} carries no transactions.`);
  }

  const inserted = await tx
    .insert(preparedAction)
    .values({
      id: input.actionId,
      walletId: input.walletId,
      vaultId: input.vaultId,
      reportId: input.reportId,
      kind: input.kind,
      chainId: input.chainId,
      account: hexToBytes(input.account),
      calldataHash: hexToBytes(input.calldataHash),
      capabilityVersion: input.capabilityVersion,
      transactionsJson: input.transactions,
      sentCount: 0,
      previewedAmount: input.previewed.toString(),
      status: "prepared",
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({
      // The index predicate, not a row filter: this names the partial unique index in 0004 so
      // PostgreSQL can match it. An unqualified ON CONFLICT (calldata_hash) has no unique index
      // to infer and errors outright.
      target: preparedAction.calldataHash,
      where: sql`status IN ('prepared', 'simulated')`,
    })
    .returning({ id: preparedAction.id });

  const id = inserted[0]?.id;

  if (id !== undefined) {
    const stored = await readAction(tx, id);

    if (stored === null) {
      throw new ActionError(`Action ${id} vanished immediately after insertion.`);
    }

    return { action: stored, created: true };
  }

  // The digest already names a live action. Read that one back rather than the id we generated,
  // which was never written.
  const existing = await readLiveActionByDigest(tx, input.calldataHash);

  if (existing === null) {
    // The conflicting row left the live set between the insert and this read — a resimulation or a
    // submission landing concurrently. Saying so beats returning an action that is not there.
    throw new ActionError(
      `A concurrent change moved the action under digest ${input.calldataHash}. Prepare again.`,
    );
  }

  return { action: existing, created: false };
}

export interface RecordSimulationInput {
  simulationId: string;
  actionId: string;
  /** Which of the action's calls this attempt covered. */
  callIndex: number;
  blockNumber: string;
  blockHash: string;
  account: string;
  success: boolean;
  /** Null for a call that reverted. Never zero as a stand-in. */
  gasEstimate: bigint | null;
  revertClass: RevertClass;
  returnDataHash: string | null;
  providerKey: string;
  /** The deadline this simulation establishes: 3 blocks or 60 seconds, whichever comes first. */
  expiresAt: Date;
}

/**
 * Append one simulation attempt, and move the action's status and deadline with it.
 *
 * The row is appended even when the simulation failed. A refused action that leaves no trace is an
 * action nobody can explain afterwards, and "we tried and the chain said no" is the answer a user
 * needs.
 *
 * `expires_at` is rewritten here rather than only at insertion. The deadline belongs to the
 * simulation that established it, so an action carrying its first simulation's deadline after a
 * later one had refreshed it would read as expired while it was signable.
 */
export async function recordSimulation(tx: Executor, input: RecordSimulationInput): Promise<void> {
  const revertClass = revertClassSchema.parse(input.revertClass);

  await tx.insert(simulation).values({
    id: input.simulationId,
    preparedActionId: input.actionId,
    callIndex: input.callIndex,
    blockNumber: input.blockNumber,
    blockHash: hexToBytes(input.blockHash),
    account: hexToBytes(input.account),
    success: input.success,
    gasEstimate: input.gasEstimate === null ? null : input.gasEstimate.toString(),
    returnDataHash: input.returnDataHash === null ? null : hexToBytes(input.returnDataHash),
    revertClass,
    providerKey: input.providerKey,
  });

  await tx
    .update(preparedAction)
    .set({ status: "simulated", expiresAt: input.expiresAt })
    .where(eq(preparedAction.id, input.actionId));
}

export interface RecordSubmissionInput {
  actionId: string;
  /** Which call of the action this hash belongs to. */
  callIndex: number;
  chainId: number;
  transactionHash: string;
}

/**
 * Record that a wallet submitted one call of this action, identified only by hash.
 *
 * The one place a transaction hash enters TR4CE, and it enters as a report about something that
 * already happened elsewhere. Nothing here submitted it.
 *
 * Reporting the same hash for the same call again is accepted and changes nothing — it is how a
 * caller asks TR4CE to look for a receipt that had not been mined the first time. Reporting a
 * *different* hash for a call already reported is refused: that is either a duplicate submission or
 * a mix-up, and overwriting the first would erase the evidence of which.
 */
export async function recordSubmission(
  tx: Executor,
  input: RecordSubmissionInput,
): Promise<{ sentCount: number; allSent: boolean }> {
  const action = await readAction(tx, input.actionId);

  if (action === null) {
    throw new ActionError(`No action with id ${input.actionId}.`);
  }

  await tx
    .insert(transactionReceipt)
    .values({
      preparedActionId: input.actionId,
      callIndex: input.callIndex,
      chainId: input.chainId,
      transactionHash: hexToBytes(input.transactionHash),
    })
    .onConflictDoNothing({
      target: [transactionReceipt.preparedActionId, transactionReceipt.callIndex],
    });

  const existing = await readReceipt(tx, input.actionId, input.callIndex);

  if (existing === null) {
    throw new ActionError(`Receipt for ${input.actionId} call ${input.callIndex} vanished.`);
  }

  if (existing.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) {
    throw new ActionError(
      `Call ${input.callIndex} of ${input.actionId} was already reported under a different hash.`,
    );
  }

  /*
   * Counted rather than incremented. A re-report of the same hash must not advance the count, and
   * deriving it from the rows that exist makes that true without a branch: the count is whatever
   * the receipts say it is.
   */
  const [counted] = await tx
    .select({ sent: sql<number>`count(*)::int` })
    .from(transactionReceipt)
    .where(eq(transactionReceipt.preparedActionId, input.actionId));

  const sentCount = counted?.sent ?? 0;
  const callCount = callCountOf(action);
  const allSent = sentCount >= callCount;

  await tx
    .update(preparedAction)
    .set({
      sentCount,
      // Back to `prepared` while calls remain: the next one has not been simulated yet, and
      // leaving the action `submitted` is what stranded the deposit of a two-call pair.
      status: allSent ? "submitted" : "prepared",
    })
    .where(eq(preparedAction.id, input.actionId));

  return { sentCount, allSent };
}

export interface ConfirmReceiptInput {
  actionId: string;
  callIndex: number;
  blockNumber: string;
  blockHash: string;
  status: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  /** What the vault's own event reported. Null when none was found — never the preview. */
  actualAmount: bigint | null;
  observedAt: Date;
}

/**
 * Attach an observed receipt to a call, and settle the action if that call was the operation.
 *
 * All four confirmation columns move together, which a CHECK in 0004 enforces: a half-observed
 * receipt must not be readable as a confirmed one.
 *
 * Only the last call decides the action's outcome. An approval is an ERC-20 call whose receipt says
 * nothing about whether the deposit succeeded, and its status is genuinely reachable here — a
 * caller may re-report call 0 to refresh a receipt that was unmined the first time, long after both
 * hashes are in.
 */
export async function confirmReceipt(tx: Executor, input: ConfirmReceiptInput): Promise<void> {
  await tx
    .update(transactionReceipt)
    .set({
      confirmedBlockNumber: input.blockNumber,
      confirmedBlockHash: hexToBytes(input.blockHash),
      status: input.status,
      gasUsed: input.gasUsed.toString(),
      effectiveGasPrice:
        input.effectiveGasPrice === null ? null : input.effectiveGasPrice.toString(),
      actualAmount: input.actualAmount === null ? null : input.actualAmount.toString(),
      observedAt: input.observedAt,
    })
    .where(
      and(
        eq(transactionReceipt.preparedActionId, input.actionId),
        eq(transactionReceipt.callIndex, input.callIndex),
      ),
    );

  const action = await readAction(tx, input.actionId);

  if (action === null) {
    return;
  }

  const callCount = callCountOf(action);
  const isOperationCall = input.callIndex === callCount - 1;

  if (isOperationCall && action.sentCount >= callCount) {
    await tx
      .update(preparedAction)
      .set({ status: input.status === "success" ? "confirmed" : "reverted" })
      .where(eq(preparedAction.id, input.actionId));
  }
}

/**
 * Mark an action unusable, with the reason attached.
 *
 * A status change without a reason is refused by the migration, because "invalidated" on its own
 * tells a user nothing about whether resimulating would help.
 *
 * No caller in Task 7. This is the write side of the reorg path: `reorg_invalidation.subject_id`
 * became TEXT in 0002 so it could name a report, and it can name an action for the same reason.
 * Kept here, with its own test, rather than invented a caller for — an expired budget is *not* a
 * reason to write `expired`, because resimulating revives the action and a terminal status would
 * be a lie about that.
 */
export async function invalidateAction(
  tx: Executor,
  actionId: string,
  status: Extract<ActionStatus, "expired" | "invalidated">,
  reason: string,
): Promise<void> {
  await tx
    .update(preparedAction)
    .set({ status, invalidatedReason: reason })
    .where(eq(preparedAction.id, actionId));
}

export async function readAction(tx: Executor, actionId: string): Promise<StoredAction | null> {
  const rows = await tx.select(actionColumns).from(preparedAction).where(eq(preparedAction.id, actionId));

  return rows[0] === undefined ? null : toStoredAction(rows[0]);
}

/** The live action standing under a digest, if one is. */
export async function readLiveActionByDigest(
  tx: Executor,
  calldataHash: string,
): Promise<StoredAction | null> {
  const rows = await tx
    .select(actionColumns)
    .from(preparedAction)
    .where(
      and(
        eq(preparedAction.calldataHash, hexToBytes(calldataHash)),
        inArray(preparedAction.status, [...LIVE_STATUSES]),
      ),
    );

  return rows[0] === undefined ? null : toStoredAction(rows[0]);
}

export interface StoredSimulation {
  callIndex: number;
  success: boolean;
  blockNumber: string;
  blockHash: string;
  revertClass: string;
  gasEstimate: string | null;
  createdAt: Date;
}

/** The simulation attempts behind an action, newest first. */
export async function listSimulations(
  tx: Executor,
  actionId: string,
): Promise<StoredSimulation[]> {
  return tx
    .select({
      callIndex: simulation.callIndex,
      success: simulation.success,
      blockNumber: simulation.blockNumber,
      blockHash: simulation.blockHash,
      revertClass: simulation.revertClass,
      gasEstimate: simulation.gasEstimate,
      createdAt: simulation.createdAt,
    })
    .from(simulation)
    .where(eq(simulation.preparedActionId, actionId))
    .orderBy(desc(simulation.createdAt))
    .then((rows) => rows.map(toStoredSimulation));
}

/**
 * The most recent simulation attempt for an action.
 *
 * Needed because signability is judged against the block a simulation was bound to, and that block
 * lives here rather than on the action: `simulation` is append-only, so the latest row is the one
 * that decides while the earlier ones stay readable. `callIndex` comes back with it because a
 * simulation of the approval says nothing about whether the deposit may be signed.
 */
export async function latestSimulation(
  tx: Executor,
  actionId: string,
): Promise<StoredSimulation | null> {
  const rows = await tx
    .select({
      callIndex: simulation.callIndex,
      success: simulation.success,
      blockNumber: simulation.blockNumber,
      blockHash: simulation.blockHash,
      revertClass: simulation.revertClass,
      gasEstimate: simulation.gasEstimate,
      createdAt: simulation.createdAt,
    })
    .from(simulation)
    .where(eq(simulation.preparedActionId, actionId))
    .orderBy(desc(simulation.createdAt))
    .limit(1);

  return rows[0] === undefined ? null : toStoredSimulation(rows[0]);
}

function toStoredSimulation(row: {
  callIndex: number;
  success: boolean;
  blockNumber: string;
  blockHash: Uint8Array;
  revertClass: string;
  gasEstimate: string | null;
  createdAt: Date;
}): StoredSimulation {
  return { ...row, blockHash: bytesToHex(row.blockHash) };
}

export interface StoredReceipt {
  callIndex: number;
  transactionHash: string;
  status: "success" | "reverted" | null;
  confirmedBlockNumber: string | null;
  actualAmount: string | null;
}

export async function readReceipt(
  tx: Executor,
  actionId: string,
  callIndex: number,
): Promise<StoredReceipt | null> {
  const rows = await tx
    .select(receiptColumns)
    .from(transactionReceipt)
    .where(
      and(
        eq(transactionReceipt.preparedActionId, actionId),
        eq(transactionReceipt.callIndex, callIndex),
      ),
    );

  return rows[0] === undefined ? null : toStoredReceipt(rows[0]);
}

/** Every reported call of an action, in signing order. */
export async function listReceipts(tx: Executor, actionId: string): Promise<StoredReceipt[]> {
  const rows = await tx
    .select(receiptColumns)
    .from(transactionReceipt)
    .where(eq(transactionReceipt.preparedActionId, actionId))
    .orderBy(transactionReceipt.callIndex);

  return rows.map(toStoredReceipt);
}

/** How many calls an action carries. The column is JSONB, so this is a read, not an assumption. */
export function callCountOf(action: StoredAction): number {
  return Array.isArray(action.transactions) ? action.transactions.length : 0;
}

const actionColumns = {
  actionId: preparedAction.id,
  status: preparedAction.status,
  kind: preparedAction.kind,
  chainId: preparedAction.chainId,
  vaultId: preparedAction.vaultId,
  account: preparedAction.account,
  capabilityVersion: preparedAction.capabilityVersion,
  transactions: preparedAction.transactionsJson,
  sentCount: preparedAction.sentCount,
  previewed: preparedAction.previewedAmount,
  expiresAt: preparedAction.expiresAt,
  invalidatedReason: preparedAction.invalidatedReason,
} as const;

const receiptColumns = {
  callIndex: transactionReceipt.callIndex,
  transactionHash: transactionReceipt.transactionHash,
  status: transactionReceipt.status,
  confirmedBlockNumber: transactionReceipt.confirmedBlockNumber,
  actualAmount: transactionReceipt.actualAmount,
} as const;

type ActionRow = {
  [K in keyof typeof actionColumns]: unknown;
};

function toStoredAction(row: ActionRow): StoredAction {
  return {
    actionId: row.actionId as string,
    status: actionStatusSchema.parse(row.status),
    kind: row.kind as ActionKind,
    chainId: row.chainId as number,
    vaultId: row.vaultId as string,
    account: bytesToHex(row.account as Uint8Array),
    capabilityVersion: row.capabilityVersion as string,
    transactions: row.transactions,
    sentCount: row.sentCount as number,
    // numeric comes back as a string, per ERD section 9. Parsed here so no caller has to remember.
    previewed: BigInt(row.previewed as string),
    expiresAt: row.expiresAt as Date,
    invalidatedReason: row.invalidatedReason as string | null,
  };
}

function toStoredReceipt(row: { [K in keyof typeof receiptColumns]: unknown }): StoredReceipt {
  return {
    callIndex: row.callIndex as number,
    transactionHash: bytesToHex(row.transactionHash as Uint8Array),
    status: row.status as StoredReceipt["status"],
    confirmedBlockNumber: row.confirmedBlockNumber as string | null,
    actualAmount: row.actualAmount as string | null,
  };
}
