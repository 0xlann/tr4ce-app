import { keccak256, type Address, type Hex } from "viem";

import type { PreparedCall } from "./prepare.js";
import type { ChainClient } from "./vault-reader.js";

/**
 * Binding a simulation to the exact conditions it was run under.
 *
 * SMART-CONTRACT.md section 6 lists seven fields a simulation is bound to, and PRD TR-F-035 says a
 * change to any of them invalidates it. That is the whole of this module: a binding is computed,
 * and later re-computed, and the two either match or the action is not signable.
 *
 * The comparison is on a digest rather than field by field, for one reason — a field added to the
 * binding later is covered automatically, where an equality check written out by hand would keep
 * passing while silently ignoring it.
 */

/** The seven bound fields, per SMART-CONTRACT.md section 6. */
export interface SimulationBinding {
  chainId: number;
  account: Address;
  to: Address;
  /** keccak256 of the calldata. The ERD calls this "immutable action identity". */
  dataHash: Hex;
  value: string;
  blockNumber: string;
  blockHash: Hex;
  /** Which interpretation of this vault's reads was in force. */
  capabilityVersion: string;
}

/**
 * Expiry: 3 blocks or 60 seconds, whichever comes first.
 *
 * Both bounds are load-bearing and neither implies the other. On Base at two-second blocks three
 * blocks is about six seconds, so the block bound is the one that almost always fires — a test that
 * only advanced the clock would pass while the block bound was broken.
 */
export const EXPIRY_BLOCKS = 3n;
export const EXPIRY_SECONDS = 60;

export interface SimulationResult {
  status: "SUCCEEDED" | "FAILED";
  binding: SimulationBinding;
  /** Null when the call reverted; there is no gas figure for a call that did not happen. */
  gasEstimate: bigint | null;
  /** Raw revert payload, kept so a caller can show what the chain returned. */
  revertData: Hex | null;
  message: string | null;
  expiresAtBlock: bigint;
  expiresAt: string;
}

export interface SimulateOptions {
  account: Address;
  call: PreparedCall;
  /** The block the simulation is pinned to. Never `latest`: an unpinned binding binds nothing. */
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: number;
  capabilityVersion: string;
}

/**
 * Simulate one prepared call against a pinned block.
 *
 * `eth_estimateGas` rather than `eth_call`: it executes the transaction the same way but also
 * answers the question a user is about to be asked to pay, and a revert surfaces identically.
 *
 * One call, deliberately — see `nextCallToSimulate` for why a two-call deposit cannot be simulated
 * in one pass.
 */
export async function simulateCall(
  client: ChainClient,
  options: SimulateOptions,
): Promise<SimulationResult> {
  const { account, call, blockNumber, blockHash, blockTimestamp, capabilityVersion } = options;

  const binding: SimulationBinding = {
    chainId: call.chainId,
    account,
    to: call.to,
    dataHash: keccak256(call.data),
    value: call.value,
    blockNumber: blockNumber.toString(),
    blockHash,
    capabilityVersion,
  };

  const expiresAtBlock = blockNumber + EXPIRY_BLOCKS;
  const expiresAt = new Date((blockTimestamp + EXPIRY_SECONDS) * 1000).toISOString();

  try {
    const gasEstimate = await client.estimateGas({
      account,
      to: call.to,
      data: call.data,
      value: BigInt(call.value),
      blockNumber,
    });

    return {
      status: "SUCCEEDED",
      binding,
      gasEstimate,
      revertData: null,
      message: null,
      expiresAtBlock,
      expiresAt,
    };
  } catch (error) {
    return {
      status: "FAILED",
      binding,
      // No gas figure for a call that did not happen. A number here would be an invention.
      gasEstimate: null,
      revertData: extractRevertData(error),
      message: error instanceof Error ? error.message.split("\n")[0]! : String(error),
      expiresAtBlock,
      expiresAt,
    };
  }
}

/**
 * A stable digest of the binding.
 *
 * Field order is fixed here rather than taken from object insertion order, which JSON preserves and
 * which two call sites would not agree on.
 */
export function bindingDigest(binding: SimulationBinding): Hex {
  const canonical = [
    binding.chainId.toString(),
    binding.account.toLowerCase(),
    binding.to.toLowerCase(),
    binding.dataHash.toLowerCase(),
    binding.value,
    binding.blockNumber,
    binding.blockHash.toLowerCase(),
    binding.capabilityVersion,
  ].join("|");

  return keccak256(new TextEncoder().encode(canonical));
}

export type SignabilityVerdict =
  | { signable: true }
  | { signable: false; reason: "BINDING_CHANGED" | "BLOCK_BUDGET_SPENT" | "TIME_BUDGET_SPENT" | "SIMULATION_FAILED" };

export interface SignabilityCheck {
  simulation: SimulationResult;
  /** The binding recomputed from current conditions. */
  current: SimulationBinding;
  currentBlock: bigint;
  now: Date;
}

/**
 * Whether a simulated action may still be signed.
 *
 * This is Task 7's acceptance clause expressed as a function: "changing any bound field makes the
 * action non-signable until resimulation". Every rejection names which of the three ways it failed,
 * because "expired" and "you switched accounts" call for different things from the user.
 */
export function checkSignable(check: SignabilityCheck): SignabilityVerdict {
  const { simulation, current, currentBlock, now } = check;

  if (simulation.status === "FAILED") {
    // A failed simulation was never signable. Stated first so a stale failure cannot be reported
    // as merely expired, which would suggest retrying would help.
    return { signable: false, reason: "SIMULATION_FAILED" };
  }

  if (bindingDigest(current) !== bindingDigest(simulation.binding)) {
    return { signable: false, reason: "BINDING_CHANGED" };
  }

  if (currentBlock > simulation.expiresAtBlock) {
    return { signable: false, reason: "BLOCK_BUDGET_SPENT" };
  }

  if (now.getTime() > Date.parse(simulation.expiresAt)) {
    return { signable: false, reason: "TIME_BUDGET_SPENT" };
  }

  return { signable: true };
}

function extractRevertData(error: unknown): Hex | null {
  const candidate = error as { data?: unknown; cause?: { data?: unknown } };
  const data = candidate?.data ?? candidate?.cause?.data;

  return typeof data === "string" && data.startsWith("0x") ? (data as Hex) : null;
}

/**
 * Which call may be simulated right now.
 *
 * A two-call deposit cannot be simulated in one pass, and this is not a limitation to work around:
 * the `deposit` reverts against current state because the `approve` has not landed yet. Simulating
 * it anyway would require pretending the allowance exists, and then showing the user a gas figure
 * and a success status for a transaction nobody has established will succeed.
 *
 * So only the next unsent call is simulated. Once the approval is mined the chain has moved, which
 * changes the bound block and makes the deposit require its own simulation regardless — the same
 * rule that governs every other change to a bound field, arriving here as a consequence rather than
 * as a special case.
 *
 * Returns null when every call has been sent.
 */
export function nextCallToSimulate<T extends { kind: string }>(
  calls: readonly T[],
  sentCount: number,
): T | null {
  return calls[sentCount] ?? null;
}
