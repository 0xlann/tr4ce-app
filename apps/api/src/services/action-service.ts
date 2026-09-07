import { randomUUID } from "node:crypto";

import {
  bindingDigest,
  EXPIRY_BLOCKS,
  nextCallToSimulate,
  type PreparedCall,
  type SimulationBinding,
  type SimulationResult,
} from "@tr4ce/chain";
import {
  hexToBytes,
  insertPreparedAction,
  latestSimulation,
  readAction,
  recordSimulation,
  recordSubmission,
  wallet,
  walletId as deriveWalletId,
  type Database,
} from "@tr4ce/db";
import { preparedActionV1Schema, type ActionKind, type PreparedActionV1 } from "@tr4ce/domain";

import type { ActionStatusResponse, PrepareActionRequest } from "../contract.js";
import { ApiFailure } from "../errors.js";
import type { VaultRegistryEntry } from "./registry-service.js";

/**
 * Preparing an action, simulating it, and remembering what the wallet did.
 *
 * There is no method here that signs or submits, and none that could: @tr4ce/chain builds calldata
 * with a client carrying no account, and the only way a transaction hash enters TR4CE is
 * `reportSubmission`, where a caller hands one back after their own wallet sent it
 * (PRD TR-F-036, TR-F-043).
 */

/**
 * Everything this service needs from a chain.
 *
 * Narrowed to four operations rather than taking a viem client, so the API integration tests can
 * answer with fixtures instead of reaching for a provider. The chain behaviour itself is proven
 * against a writable Anvil fork in `packages/chain/src/actions.fork.test.ts`; these tests check the
 * wiring, the persistence and the error envelope. Different questions — running both through one
 * fork would make the suite slower and neither answer clearer.
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
 * Prepare, simulate, and store both.
 *
 * Only the first unsent call is simulated. The second transaction of a deposit reverts against
 * current state because the approval has not landed, so simulating it would attach a success status
 * and a gas figure to something nobody has established will succeed. `nextCallToSimulate` in
 * @tr4ce/chain carries that rule and the reasoning behind it.
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

  const block = await chain.currentBlock();
  const first = nextCallToSimulate(outcome.calls, 0)!;
  const capabilityVersion = `${vault.adapterKey}@${vault.adapterVersion}`;

  const simulation = await chain.simulate({
    account: request.owner,
    call: first,
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    capabilityVersion,
  });

  const actionId = deriveActionId(simulation.binding);
  const transactions = outcome.calls.map(toWireTransaction);

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

    const action = await insertPreparedAction(tx, {
      actionId,
      walletId: walletRowId,
      vaultId: vault.vaultId,
      reportId: request.reportId ?? null,
      kind: request.operation as ActionKind,
      chainId: request.chainId,
      account: request.owner,
      calldataHash: bindingDigest(simulation.binding),
      transactions,
      expiresAt: new Date(simulation.expiresAt),
    });

    // Appended whether it succeeded or not. An action refused without a trace is one nobody can
    // explain afterwards, and "we tried and the chain said no" is what a user needs to be told.
    await recordSimulation(tx, {
      simulationId: randomUUID(),
      actionId: action.actionId,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      account: request.owner,
      success: simulation.status === "SUCCEEDED",
      gasEstimate: simulation.gasEstimate,
      revertClass: simulation.status === "SUCCEEDED" ? "none" : "reverted",
      returnDataHash: null,
      providerKey: options.providerKey,
    });

    return action;
  });

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
    simulation: {
      status: simulation.status,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      expiresAt: simulation.expiresAt,
      gasEstimate: simulation.gasEstimate === null ? null : simulation.gasEstimate.toString(),
      // A revert is evidence about the chain, not a gap in our observations, but the response
      // contract carries reason codes and `SIMULATION_REVERTED` is the one that fits.
      reasonCodes: simulation.status === "SUCCEEDED" ? [] : ["SIMULATION_REVERTED"],
    },
  });
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
  const stored = await readAction(options.db, actionId);

  if (stored === null) {
    throw new ApiFailure("ACTION_NOT_FOUND", 404, `No action with id ${actionId}.`);
  }

  const expiresAt = stored.expiresAt.toISOString();

  // Terminal states are terminal. An action already submitted is not "expired" because time
  // passed, and reporting it that way would invite a second submission of the same transaction.
  if (stored.status !== "prepared" && stored.status !== "simulated") {
    return {
      schemaVersion: "1.0.0",
      actionId,
      status: stored.status,
      signable: false,
      reason: stored.invalidatedReason,
      expiresAt,
    };
  }

  const attempt = await latestSimulation(options.db, actionId);

  if (attempt === null || !attempt.success) {
    // Never successfully simulated. Reporting this as an expiry would suggest resimulating helps,
    // and the user would repeat a transaction the chain has already refused.
    return {
      schemaVersion: "1.0.0",
      actionId,
      status: stored.status,
      signable: false,
      reason: "SIMULATION_FAILED",
      expiresAt,
    };
  }

  const block = await options.chain.currentBlock();

  if (block.number > BigInt(attempt.blockNumber) + EXPIRY_BLOCKS) {
    return {
      schemaVersion: "1.0.0",
      actionId,
      status: stored.status,
      signable: false,
      reason: "BLOCK_BUDGET_SPENT",
      expiresAt,
    };
  }

  if (options.now().getTime() > stored.expiresAt.getTime()) {
    return {
      schemaVersion: "1.0.0",
      actionId,
      status: stored.status,
      signable: false,
      reason: "TIME_BUDGET_SPENT",
      expiresAt,
    };
  }

  return {
    schemaVersion: "1.0.0",
    actionId,
    status: stored.status,
    signable: true,
    reason: null,
    expiresAt,
  };
}

/**
 * Record a transaction hash the caller reports.
 *
 * The single point at which a hash enters TR4CE, and it arrives as a report about something that
 * already happened elsewhere. Nothing here submitted it.
 */
export async function reportSubmission(
  options: ActionServiceOptions,
  input: { actionId: string; chainId: number; transactionHash: string },
): Promise<ActionStatusResponse> {
  const stored = await readAction(options.db, input.actionId);

  if (stored === null) {
    throw new ApiFailure("ACTION_NOT_FOUND", 404, `No action with id ${input.actionId}.`);
  }

  if (stored.status !== "prepared" && stored.status !== "simulated") {
    // Reporting a second hash for one action would mean either a duplicate submission or a mix-up,
    // and quietly overwriting the first would erase the evidence of which.
    throw new ApiFailure(
      "ACTION_NOT_AVAILABLE",
      409,
      `Action ${input.actionId} is already ${stored.status}.`,
    );
  }

  await options.db.transaction((tx) => recordSubmission(tx, input));

  return actionSignability(options, input.actionId);
}

/** `act_` plus the first 32 hex of the binding digest — the same shape a report id uses. */
export function deriveActionId(binding: SimulationBinding): string {
  return `act_${bindingDigest(binding).slice(2, 34)}`;
}

function toWireTransaction(call: PreparedCall) {
  return { chainId: call.chainId, to: call.to, data: call.data, value: call.value };
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
