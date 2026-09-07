import {
  actionStatusSchema,
  revertClassSchema,
  type ActionKind,
  type ActionStatus,
  type RevertClass,
} from "@tr4ce/domain";
import { desc, eq } from "drizzle-orm";

import type { Executor } from "../client.js";
import { hexToBytes } from "../schema/columns.js";
import { preparedAction, simulation, transactionReceipt } from "../schema/actions.js";

/**
 * Storing prepared actions and what happened to them.
 *
 * No function here accepts, returns, or has anywhere to put a signature. `recordSubmission` takes a
 * transaction hash the caller reports after their own wallet submitted, which is the only thing
 * TR4CE ever learns about a signed transaction (PRD TR-F-043).
 */

export interface InsertActionInput {
  actionId: string;
  walletId: string;
  vaultId: string;
  /** Null when no report motivated this action. */
  reportId: string | null;
  kind: ActionKind;
  chainId: number;
  account: string;
  /** The binding digest, as 0x-prefixed hex. */
  calldataHash: string;
  transactions: readonly unknown[];
  expiresAt: Date;
}

export interface StoredAction {
  actionId: string;
  status: ActionStatus;
  transactions: unknown;
  expiresAt: Date;
  invalidatedReason: string | null;
  /** False when an identical action was already prepared and this call wrote nothing. */
  created: boolean;
}

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * Store a prepared action, or return the one already stored under the same binding.
 *
 * Idempotent for the same reason report creation is: the id is derived from the binding, so
 * preparing the same action twice under the same conditions names the same action rather than
 * accumulating rows a user would have to choose between.
 */
export async function insertPreparedAction(
  tx: Executor,
  input: InsertActionInput,
): Promise<StoredAction> {
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
      transactionsJson: input.transactions,
      status: "prepared",
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: preparedAction.id });

  const stored = await readAction(tx, input.actionId);

  if (stored === null) {
    throw new ActionError(`Action ${input.actionId} vanished immediately after insertion.`);
  }

  return { ...stored, created: inserted.length > 0 };
}

export interface RecordSimulationInput {
  simulationId: string;
  actionId: string;
  blockNumber: string;
  blockHash: string;
  account: string;
  success: boolean;
  /** Null for a call that reverted. Never zero as a stand-in. */
  gasEstimate: bigint | null;
  revertClass: RevertClass;
  returnDataHash: string | null;
  providerKey: string;
}

/**
 * Append one simulation attempt and move the action to `simulated`.
 *
 * The row is appended even when the simulation failed. A refused action that leaves no trace is an
 * action nobody can explain afterwards, and "we tried and the chain said no" is the answer a user
 * needs.
 */
export async function recordSimulation(
  tx: Executor,
  input: RecordSimulationInput,
): Promise<void> {
  const revertClass = revertClassSchema.parse(input.revertClass);

  await tx.insert(simulation).values({
    id: input.simulationId,
    preparedActionId: input.actionId,
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
    .set({ status: "simulated" })
    .where(eq(preparedAction.id, input.actionId));
}

/**
 * Record that a wallet submitted this action, identified only by hash.
 *
 * The one place a transaction hash enters the system, and it enters as a report from the caller.
 * Nothing here submitted anything.
 */
export async function recordSubmission(
  tx: Executor,
  input: { actionId: string; chainId: number; transactionHash: string },
): Promise<void> {
  await tx.insert(transactionReceipt).values({
    preparedActionId: input.actionId,
    chainId: input.chainId,
    transactionHash: hexToBytes(input.transactionHash),
  });

  await tx
    .update(preparedAction)
    .set({ status: "submitted" })
    .where(eq(preparedAction.id, input.actionId));
}

/**
 * Mark an action unusable, with the reason attached.
 *
 * A status change without a reason is refused by the migration, because "invalidated" on its own
 * tells a user nothing about whether resimulating would help.
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

export async function readAction(
  tx: Executor,
  actionId: string,
): Promise<Omit<StoredAction, "created"> | null> {
  const rows = await tx
    .select({
      actionId: preparedAction.id,
      status: preparedAction.status,
      transactions: preparedAction.transactionsJson,
      expiresAt: preparedAction.expiresAt,
      invalidatedReason: preparedAction.invalidatedReason,
    })
    .from(preparedAction)
    .where(eq(preparedAction.id, actionId));

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  return { ...row, status: actionStatusSchema.parse(row.status) };
}

/** The simulation attempts behind an action, newest first. */
export async function listSimulations(
  tx: Executor,
  actionId: string,
): Promise<{ success: boolean; blockNumber: string; revertClass: string; createdAt: Date }[]> {
  return tx
    .select({
      success: simulation.success,
      blockNumber: simulation.blockNumber,
      revertClass: simulation.revertClass,
      createdAt: simulation.createdAt,
    })
    .from(simulation)
    .where(eq(simulation.preparedActionId, actionId))
    .orderBy(desc(simulation.createdAt));
}

/**
 * The most recent simulation attempt for an action.
 *
 * Needed because signability is judged against the block a simulation was bound to, and that block
 * lives here rather than on the action: `simulation` is append-only, so the latest row is the one
 * that decides while the earlier ones stay readable.
 */
export async function latestSimulation(
  tx: Executor,
  actionId: string,
): Promise<{ success: boolean; blockNumber: string; revertClass: string } | null> {
  const rows = await tx
    .select({
      success: simulation.success,
      blockNumber: simulation.blockNumber,
      revertClass: simulation.revertClass,
    })
    .from(simulation)
    .where(eq(simulation.preparedActionId, actionId))
    .orderBy(desc(simulation.createdAt))
    .limit(1);

  return rows[0] ?? null;
}
