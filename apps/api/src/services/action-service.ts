import { randomUUID } from "node:crypto";

import {
  actionDigest,
  decodeDeposit,
  decodeRedeem,
  EXPIRY_BLOCKS,
  type ActionReceipt,
  type PreparedCall,
  type SimulationResult,
} from "@tr4ce/chain";
import {
  callCountOf,
  confirmReceipt,
  hexToBytes,
  insertPreparedAction,
  latestSimulation,
  listReceipts,
  listSimulations,
  readAction,
  readLiveActionByDigest,
  recordSimulation,
  recordSubmission,
  wallet,
  walletId as deriveWalletId,
  type Database,
  type StoredAction,
  type StoredReceipt,
  type StoredSimulation,
} from "@tr4ce/db";
import {
  actionOutcomeSchema,
  preparedActionV1Schema,
  revertClassSchema,
  unsignedTransactionSchema,
  type ActionKind,
  type ActionOutcome,
  type PreparedActionV1,
  type UnsignedTransaction,
} from "@tr4ce/domain";

import { simulationAttemptSchema, type ActionStatusResponse, type PrepareActionRequest } from "../contract.js";
import { ApiFailure } from "../errors.js";
import type { VaultRegistryEntry } from "./registry-service.js";

/**
 * Preparing an action, simulating it, and remembering what the wallet did.
 *
 * There is no method here that signs or submits, and none that could: @tr4ce/chain builds calldata
 * with a client carrying no account, and the only way a transaction hash enters TR4CE is
 * `reportSubmission`, where a caller hands one back after their own wallet sent it
 * (PRD TR-F-036, TR-F-043).
 *
 * The shape of the flow is set by one fact about ERC-4626: a deposit whose allowance falls short is
 * *two* transactions, and the second cannot be simulated until the first has landed. So an action
 * is a plan of one or more calls, each simulated against the block it will be signed at, each
 * reported back separately. Everything below follows from that.
 */

/**
 * Everything this service needs from a chain.
 *
 * Narrowed to five read-only operations rather than taking a viem client, so the API integration
 * tests can answer with fixtures instead of reaching for a provider. The chain behaviour itself is
 * proven against a writable Anvil fork in `packages/chain/src/actions.fork.test.ts`; these tests
 * check the wiring, the persistence and the error envelope. Different questions — running both
 * through one fork would make the suite slower and neither answer clearer.
 *
 * Every method reads. `receipt` looks up a transaction the caller already sent; there is no method
 * that could send one, and `no-signing.test.ts` fails if this file names one.
 */
export interface ActionChain {
  prepareDeposit(input: {
    vault: string;
    asset: string;
    owner: string;
    receiver: string;
    assets: bigint;
  }): Promise<PrepareOutcome>;
  prepareRedeem(input: {
    vault: string;
    owner: string;
    receiver: string;
    shares: bigint;
  }): Promise<PrepareOutcome>;
  currentBlock(): Promise<{ number: bigint; hash: `0x${string}`; timestamp: number }>;
  simulate(input: {
    account: string;
    call: PreparedCall;
    blockNumber: bigint;
    blockHash: `0x${string}`;
    blockTimestamp: number;
    capabilityVersion: string;
  }): Promise<SimulationResult>;
  /** The receipt for a hash the caller reported, or null when it is not mined yet. */
  receipt(transactionHash: string): Promise<ActionReceipt | null>;
}

export type PrepareOutcome =
  | { ok: true; calls: PreparedCall[]; previewed: bigint }
  | { ok: false; code: string };

export interface ActionServiceOptions {
  db: Database;
  chain: ActionChain;
  /** Names the provider on every stored simulation. Never a credential. */
  providerKey: string;
  now: () => Date;
}

/**
 * Prepare an action, simulate its first call, and store both.
 *
 * Only the first call is simulated. The second transaction of a deposit reverts against current
 * state because the approval has not landed, so simulating it would attach a success status and a
 * gas figure to something nobody has established will succeed. It gets its own simulation later,
 * through `simulateNextCall`, once the approval is mined.
 *
 * Preparing the same plan twice while the first is still awaiting signature returns that one.
 * Preparing it again after it has been sent creates a new action — see `insertPreparedAction`.
 */
export async function prepareAction(
  options: ActionServiceOptions,
  request: PrepareActionRequest,
  vault: VaultRegistryEntry,
): Promise<PreparedActionV1> {
  const { db, chain } = options;
  const amount = BigInt(request.amount);

  const outcome =
    request.operation === "deposit"
      ? await chain.prepareDeposit({
          vault: vault.address,
          asset: vault.assetAddress,
          owner: request.owner,
          receiver: request.receiver,
          assets: amount,
        })
      : await chain.prepareRedeem({
          vault: vault.address,
          owner: request.owner,
          receiver: request.receiver,
          shares: amount,
        });

  if (!outcome.ok) {
    throw new ApiFailure("ACTION_NOT_AVAILABLE", 409, describeFailure(outcome.code));
  }

  const capabilityVersion = `${vault.adapterKey}@${vault.adapterVersion}`;
  const digest = actionDigest({
    chainId: request.chainId,
    account: request.owner as `0x${string}`,
    calls: outcome.calls,
    capabilityVersion,
  });

  const transactions = outcome.calls.map(toWireTransaction);

  const live = await readLiveActionByDigest(db, digest);

  if (live !== null) {
    /*
     * Still awaiting a signature, so the same action comes back rather than a second row.
     *
     * The simulation shown is the one for the call that is *next*, not the newest on record. After
     * the approval is reported the action returns to `prepared` with the deposit outstanding, and
     * showing the approval's attempt would put a spent transaction's gas figure and block beside a
     * button that signs a different transaction. When that call has no attempt yet — the ordinary
     * state right after a hash is reported — one is run here, exactly as it is for a fresh action.
     */
    const existing = await simulationForCall(options, live.actionId, live.sentCount);
    const attempt =
      existing ?? (await simulateAndRecord(options, live, live.sentCount, outcome.calls[live.sentCount]));

    return buildPreparedAction(live, request, vault, transactions, attempt);
  }

  const block = await chain.currentBlock();
  const first = outcome.calls[0]!;

  const simulation = await chain.simulate({
    account: request.owner,
    call: first,
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    capabilityVersion,
  });

  const stored = await db.transaction(async (tx) => {
    /*
     * A wallet row for the owner, keyed the way a policy's owner already is. Reusing the derived id
     * means an owner who holds both a policy and an action is one wallet rather than two.
     */
    const walletRowId = deriveWalletId(request.owner);

    await tx
      .insert(wallet)
      .values({ id: walletRowId, chainScope: null, address: hexToBytes(request.owner) })
      .onConflictDoNothing({ target: wallet.id });

    const { action, created } = await insertPreparedAction(tx, {
      actionId: newActionId(),
      walletId: walletRowId,
      vaultId: vault.vaultId,
      reportId: request.reportId ?? null,
      kind: request.operation as ActionKind,
      chainId: request.chainId,
      account: request.owner,
      calldataHash: digest,
      capabilityVersion,
      transactions,
      previewed: outcome.previewed,
      expiresAt: new Date(simulation.expiresAt),
    });

    if (!created) {
      // A concurrent request won the race. Its simulation is the one on record; ours is discarded
      // rather than appended to an action it was not run for.
      return action;
    }

    // Appended whether it succeeded or not. An action refused without a trace is one nobody can
    // explain afterwards, and "we tried and the chain said no" is what a user needs to be told.
    await recordSimulation(tx, simulationRow(options, action.actionId, 0, request.owner, block, simulation));

    return action;
  });

  const attempt = await latestSimulation(db, stored.actionId);

  if (attempt === null) {
    // Insertion and the first simulation share one transaction, so an action without an attempt is
    // an inconsistency rather than a state. Saying so beats reporting a zeroed block as its binding.
    throw new ApiFailure(
      "INTERNAL_ERROR",
      500,
      `Action ${stored.actionId} was stored without a simulation.`,
    );
  }

  return buildPreparedAction(stored, request, vault, transactions, attempt);
}

/**
 * Simulate the next unsent call against the current block.
 *
 * This is the resimulation half of Task 7's acceptance clause — *"changing any bound field makes
 * the action non-signable until resimulation"*. Without it the second sentence names something a
 * caller cannot do, and the deposit of a two-call pair could never be signed at all.
 *
 * Appends an attempt; never replaces one. The history of what the chain said, and when, is the
 * point of the table.
 */
export async function simulateNextCall(
  options: ActionServiceOptions,
  actionId: string,
): Promise<ActionStatusResponse> {
  const stored = await requireAction(options, actionId);

  if (stored.status !== "prepared" && stored.status !== "simulated") {
    throw new ApiFailure(
      "ACTION_NOT_AVAILABLE",
      409,
      `Action ${actionId} is ${stored.status} and has nothing left to simulate.`,
    );
  }

  const calls = callsOf(stored);
  const callIndex = stored.sentCount;
  const call = calls[callIndex];

  if (call === undefined) {
    throw new ApiFailure(
      "ACTION_NOT_AVAILABLE",
      409,
      `Every call of action ${actionId} has been reported.`,
    );
  }

  await simulateAndRecord(options, stored, callIndex, toPreparedCall(call));

  return actionSignability(options, actionId);
}

/**
 * Simulate one call of a stored action against the current block and append the attempt.
 *
 * Shared by the resimulation route and by a repeat `prepare` that lands on a live action, so the
 * two cannot drift into simulating against different blocks or binding to different capability
 * versions.
 */
async function simulateAndRecord(
  options: ActionServiceOptions,
  stored: StoredAction,
  callIndex: number,
  call: PreparedCall | undefined,
): Promise<StoredSimulation> {
  if (call === undefined) {
    throw new ApiFailure(
      "ACTION_NOT_AVAILABLE",
      409,
      `Every call of action ${stored.actionId} has been reported.`,
    );
  }

  const block = await options.chain.currentBlock();

  const simulation = await options.chain.simulate({
    account: stored.account,
    call,
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    capabilityVersion: stored.capabilityVersion,
  });

  await options.db.transaction((tx) =>
    recordSimulation(
      tx,
      simulationRow(options, stored.actionId, callIndex, stored.account, block, simulation),
    ),
  );

  const attempt = await simulationForCall(options, stored.actionId, callIndex);

  if (attempt === null) {
    throw new ApiFailure(
      "INTERNAL_ERROR",
      500,
      `Simulation of call ${callIndex} of ${stored.actionId} was not recorded.`,
    );
  }

  return attempt;
}

/** The newest attempt for one call, or null when that call has never been simulated. */
async function simulationForCall(
  options: ActionServiceOptions,
  actionId: string,
  callIndex: number,
): Promise<StoredSimulation | null> {
  const attempts = await listSimulations(options.db, actionId);

  return attempts.find((attempt) => attempt.callIndex === callIndex) ?? null;
}

/**
 * Whether a stored action may still be signed, judged against the chain right now.
 *
 * Recomputed rather than read back. The stored status says what was true when the row was written,
 * and the entire purpose of the binding is that the world moves afterwards — an endpoint that
 * echoed `status: "simulated"` would be answering a question from the past.
 *
 * Both budgets are checked, because neither implies the other: three blocks is about six seconds on
 * Base, so the block bound normally fires first, while a stalled chain would leave an action
 * signable forever under a block-only rule.
 */
export async function actionSignability(
  options: ActionServiceOptions,
  actionId: string,
): Promise<ActionStatusResponse> {
  const stored = await requireAction(options, actionId);
  const [attempts, receipts] = await Promise.all([
    listSimulations(options.db, actionId),
    listReceipts(options.db, actionId),
  ]);

  const base = statusEnvelope(stored, attempts, receipts);

  // Terminal states are terminal. An action already fully submitted is not "expired" because time
  // passed, and reporting it that way would invite a second submission of the same transaction.
  if (stored.status !== "prepared" && stored.status !== "simulated") {
    return { ...base, signable: false, reason: stored.invalidatedReason };
  }

  const attempt = attempts[0] ?? null;

  if (attempt === null || !attempt.success) {
    // Never successfully simulated. Reporting this as an expiry would suggest resimulating helps,
    // and the user would repeat a transaction the chain has already refused.
    return { ...base, signable: false, reason: "SIMULATION_FAILED" };
  }

  /*
   * The guard the whole two-call flow rests on.
   *
   * `attempt` is the newest simulation, which may well be the approval's. The call now awaiting
   * signature is `sentCount`. If those disagree, the next call has not been simulated and saying
   * it is signable would let a wallet sign a deposit on the strength of an approval's gas estimate
   * — exactly what PRD TR-F-032 forbids.
   */
  if (attempt.callIndex !== stored.sentCount) {
    return { ...base, signable: false, reason: "NOT_SIMULATED" };
  }

  const block = await options.chain.currentBlock();

  if (block.number > BigInt(attempt.blockNumber) + EXPIRY_BLOCKS) {
    return { ...base, signable: false, reason: "BLOCK_BUDGET_SPENT" };
  }

  if (options.now().getTime() > stored.expiresAt.getTime()) {
    return { ...base, signable: false, reason: "TIME_BUDGET_SPENT" };
  }

  return { ...base, signable: true, reason: null };
}

/**
 * Record a transaction hash the caller reports for one call, and look once for its receipt.
 *
 * The single point at which a hash enters TR4CE, and it arrives as a report about something that
 * already happened elsewhere. Nothing here submitted it.
 *
 * Reporting the same hash for the same call again is accepted and is how a caller asks TR4CE to
 * look for a receipt that had not been mined the first time. TR4CE does not poll on its own.
 */
export async function reportSubmission(
  options: ActionServiceOptions,
  input: { actionId: string; callIndex: number; chainId: number; transactionHash: string },
): Promise<ActionStatusResponse> {
  const stored = await requireAction(options, input.actionId);
  const calls = callsOf(stored);
  const call = calls[input.callIndex];

  if (call === undefined) {
    throw new ApiFailure(
      "INVALID_REQUEST",
      400,
      `Action ${input.actionId} has ${calls.length} call(s); there is no call ${input.callIndex}.`,
    );
  }

  const alreadyReported = await findReceipt(options, input.actionId, input.callIndex);

  /*
   * In order, and only the call that is actually next.
   *
   * Reporting call 1 before call 0 would mean either a mix-up or a deposit signed without its
   * approval, and recording it would put the count — and every signability answer derived from it
   * — out of step with what the wallet actually did.
   */
  if (alreadyReported === null && input.callIndex !== stored.sentCount) {
    throw new ApiFailure(
      "ACTION_NOT_AVAILABLE",
      409,
      `Call ${stored.sentCount} of action ${input.actionId} has not been reported yet.`,
    );
  }

  try {
    await options.db.transaction((tx) => recordSubmission(tx, input));
  } catch (error) {
    throw new ApiFailure("ACTION_NOT_AVAILABLE", 409, messageOf(error));
  }

  await observeReceipt(options, input.actionId, input.callIndex, input.transactionHash);

  return actionSignability(options, input.actionId);
}

/**
 * Look once for the receipt of a reported hash and store what it says.
 *
 * One lookup, not a poll. A hash is routinely reported before it is mined, and in that case nothing
 * is written — the caller reports the same hash again later and TR4CE looks again. The alternative,
 * watching the chain on the user's behalf, would mean taking responsibility for transactions TR4CE
 * never agreed to track.
 */
async function observeReceipt(
  options: ActionServiceOptions,
  actionId: string,
  callIndex: number,
  transactionHash: string,
): Promise<void> {
  const existing = await findReceipt(options, actionId, callIndex);

  if (existing !== null && existing.status !== null) {
    // Already observed. Re-reading would risk overwriting a settled receipt with a reorg's answer,
    // which belongs to the invalidation path rather than here.
    return;
  }

  const receipt = await options.chain.receipt(transactionHash);

  if (receipt === null) {
    return;
  }

  const stored = await readAction(options.db, actionId);

  if (stored === null) {
    return;
  }

  await options.db.transaction((tx) =>
    confirmReceipt(tx, {
      actionId,
      callIndex,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: null,
      actualAmount: decodeActual(stored, callIndex, receipt),
      observedAt: options.now(),
    }),
  );
}

/**
 * The amount the vault's own event reported, or null.
 *
 * Only the operation call carries one: an ERC-20 approval emits no ERC-4626 event, and reading one
 * out of it would be inventing a number. Null when the event is absent for any other reason too —
 * SMART-CONTRACT.md sections 4 and 5 require the actual to come from execution evidence and to be
 * "not replaced by preview".
 */
function decodeActual(
  action: StoredAction,
  callIndex: number,
  receipt: ActionReceipt,
): bigint | null {
  const calls = callsOf(action);
  const call = calls[callIndex];

  if (call === undefined || call.kind === "approve") {
    return null;
  }

  const vault = call.to as `0x${string}`;
  const owner = action.account as `0x${string}`;

  return action.kind === "deposit"
    ? decodeDeposit(receipt, vault, owner, action.previewed).actualShares
    : decodeRedeem(receipt, vault, owner, action.previewed).actualAssets;
}

/** `act_` plus 32 generated hex — the same shape a report id has, without the derivation. */
export function newActionId(): string {
  return `act_${randomUUID().replaceAll("-", "").slice(0, 32)}`;
}

async function requireAction(
  options: ActionServiceOptions,
  actionId: string,
): Promise<StoredAction> {
  const stored = await readAction(options.db, actionId);

  if (stored === null) {
    throw new ApiFailure("ACTION_NOT_FOUND", 404, `No action with id ${actionId}.`);
  }

  return stored;
}

async function findReceipt(
  options: ActionServiceOptions,
  actionId: string,
  callIndex: number,
): Promise<StoredReceipt | null> {
  const receipts = await listReceipts(options.db, actionId);

  return receipts.find((receipt) => receipt.callIndex === callIndex) ?? null;
}

/** Everything in the status response that does not depend on whether it is signable. */
function statusEnvelope(
  stored: StoredAction,
  attempts: StoredSimulation[],
  receipts: StoredReceipt[],
): Omit<ActionStatusResponse, "signable" | "reason"> {
  const callCount = callCountOf(stored);

  return {
    schemaVersion: "1.0.0",
    actionId: stored.actionId,
    status: stored.status,
    expiresAt: stored.expiresAt.toISOString(),
    callCount,
    sentCount: stored.sentCount,
    nextCallIndex: stored.sentCount < callCount ? stored.sentCount : null,
    outcome: outcomeOf(stored, receipts),
    // Parsed, not cast. The database hands back plain strings and the contract's brands exist so
    // a block number cannot quietly stand in for a token amount.
    attempts: attempts.map((attempt) =>
      simulationAttemptSchema.parse({
        callIndex: attempt.callIndex,
        success: attempt.success,
        blockNumber: attempt.blockNumber,
        revertClass: revertClassSchema.parse(attempt.revertClass),
        gasEstimate: attempt.gasEstimate,
        at: attempt.createdAt.toISOString(),
      }),
    ),
  };
}

/**
 * Preview beside actual, for the operation call only.
 *
 * `delta` is null rather than zero when the event was not observed, because "we saw no difference"
 * and "we saw nothing" are different claims and only the second one would be true.
 */
function outcomeOf(stored: StoredAction, receipts: StoredReceipt[]): ActionOutcome | null {
  const calls = callsOf(stored);
  const operationIndex = calls.findIndex((call) => call.kind !== "approve");

  if (operationIndex < 0) {
    return null;
  }

  const receipt = receipts.find((candidate) => candidate.callIndex === operationIndex);

  if (receipt === undefined) {
    return null;
  }

  const previewed = stored.previewed.toString();
  const actual = receipt.actualAmount;

  return actionOutcomeSchema.parse({
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    confirmedBlockNumber: receipt.confirmedBlockNumber,
    previewed,
    actual,
    delta: actual === null ? null : (BigInt(actual) - stored.previewed).toString(),
  });
}

function buildPreparedAction(
  stored: StoredAction,
  request: PrepareActionRequest,
  vault: VaultRegistryEntry,
  transactions: UnsignedTransaction[],
  attempt: StoredSimulation,
): PreparedActionV1 {
  return preparedActionV1Schema.parse({
    schemaVersion: "1.0.0",
    actionId: stored.actionId,
    operation: request.operation,
    vault: vault.address,
    asset: vault.assetAddress,
    owner: request.owner,
    receiver: request.receiver,
    amount: request.amount,
    transactions,
    previewed: stored.previewed.toString(),
    simulation: {
      status: attempt.success ? "SUCCEEDED" : "FAILED",
      blockNumber: attempt.blockNumber,
      blockHash: attempt.blockHash,
      expiresAt: stored.expiresAt.toISOString(),
      gasEstimate: attempt.gasEstimate,
      // A revert is evidence about the chain, not a gap in our observations, but the response
      // contract carries reason codes and `SIMULATION_REVERTED` is the one that fits.
      reasonCodes: attempt.success ? [] : ["SIMULATION_REVERTED"],
    },
  });
}

function simulationRow(
  options: ActionServiceOptions,
  actionId: string,
  callIndex: number,
  account: string,
  block: { number: bigint; hash: `0x${string}` },
  simulation: SimulationResult,
) {
  const succeeded = simulation.status === "SUCCEEDED";

  return {
    simulationId: randomUUID(),
    actionId,
    callIndex,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    account,
    success: succeeded,
    gasEstimate: simulation.gasEstimate,
    revertClass: succeeded ? ("none" as const) : ("reverted" as const),
    returnDataHash: null,
    providerKey: options.providerKey,
    expiresAt: new Date(simulation.expiresAt),
  };
}

/** The stored calls, parsed back through the contract rather than cast. */
function callsOf(stored: StoredAction): UnsignedTransaction[] {
  return unsignedTransactionSchema.array().parse(stored.transactions);
}

function toPreparedCall(transaction: UnsignedTransaction): PreparedCall {
  return {
    chainId: transaction.chainId,
    to: transaction.to as `0x${string}`,
    data: transaction.data as `0x${string}`,
    value: transaction.value,
    kind: transaction.kind,
  };
}

function toWireTransaction(call: PreparedCall): UnsignedTransaction {
  return unsignedTransactionSchema.parse({
    chainId: call.chainId,
    to: call.to,
    data: call.data,
    value: call.value,
    kind: call.kind,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal a user can act on, rather than the internal code. */
function describeFailure(code: string): string {
  switch (code) {
    case "ASSET_MISMATCH":
      return "The vault does not hold the asset it was asked about.";
    case "INSUFFICIENT_BALANCE":
      return "The owner's balance does not cover this amount.";
    case "LIMIT_EXCEEDED":
      return "The vault will not accept this amount at the current block.";
    case "AMOUNT_NOT_POSITIVE":
      return "The amount must be greater than zero.";
    case "PREVIEW_ZERO":
      return "The vault previews zero shares for this amount, which would be a loss.";
    case "PREVIEW_UNAVAILABLE":
      return "The vault did not answer the preview call, so the outcome cannot be shown.";
    default:
      return "The action could not be prepared against current chain state.";
  }
}
