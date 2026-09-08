import { decodeEventLog, type Address, type Hex, type Log } from "viem";

import { erc4626Abi } from "./abis.js";

/**
 * Reading what actually happened, and comparing it to what was previewed.
 *
 * SMART-CONTRACT.md sections 4 and 5 are explicit that actual amounts come from execution evidence
 * and are "not replaced by preview". This module therefore never falls back: when the matching
 * event is absent the actual value is null, and a caller has to say so rather than quietly showing
 * the preview as though it were the outcome.
 *
 * TR4CE learns a transaction hash only because the caller hands one back after their wallet
 * submitted it (PRD TR-F-043). Nothing here submits, and nothing here polls for one.
 */

export interface ActionReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  gasUsed: bigint;
  /** What the sender actually paid per unit of gas. Null when the node did not report it. */
  effectiveGasPrice: bigint | null;
  logs: readonly Log[];
}

export interface DepositOutcome {
  kind: "deposit";
  /** Shares the `Deposit` event reported. Null when no matching event was emitted. */
  actualShares: bigint | null;
  actualAssets: bigint | null;
  previewedShares: bigint;
  /** `actual - previewed`. Null when there is nothing to compare, never zero as a stand-in. */
  shareDelta: bigint | null;
}

export interface RedeemOutcome {
  kind: "redeem";
  actualAssets: bigint | null;
  actualShares: bigint | null;
  previewedAssets: bigint;
  assetDelta: bigint | null;
}

/**
 * Decode the `Deposit` this vault emitted for this owner.
 *
 * Matched on the emitting address as well as the event shape: a deposit routed through a protocol
 * that emits its own `Deposit` would otherwise let another contract's numbers be reported as this
 * vault's.
 */
export function decodeDeposit(
  receipt: ActionReceipt,
  vault: Address,
  owner: Address,
  previewedShares: bigint,
): DepositOutcome {
  const event = findEvent(receipt, vault, "Deposit", owner);

  const actualShares = event === null ? null : (event["shares"] as bigint);
  const actualAssets = event === null ? null : (event["assets"] as bigint);

  return {
    kind: "deposit",
    actualShares,
    actualAssets,
    previewedShares,
    // Null rather than zero when the event is missing: "we saw no difference" and "we saw nothing"
    // are different claims, and only one of them is true here.
    shareDelta: actualShares === null ? null : actualShares - previewedShares,
  };
}

export function decodeRedeem(
  receipt: ActionReceipt,
  vault: Address,
  owner: Address,
  previewedAssets: bigint,
): RedeemOutcome {
  const event = findEvent(receipt, vault, "Withdraw", owner);

  const actualAssets = event === null ? null : (event["assets"] as bigint);
  const actualShares = event === null ? null : (event["shares"] as bigint);

  return {
    kind: "redeem",
    actualAssets,
    actualShares,
    previewedAssets,
    assetDelta: actualAssets === null ? null : actualAssets - previewedAssets,
  };
}

/**
 * The first matching event this vault emitted for this owner.
 *
 * A log that fails to decode is skipped rather than thrown on: a transaction routinely carries logs
 * from other contracts, and one of them failing to parse as an ERC-4626 event says nothing about
 * whether ours is present.
 */
function findEvent(
  receipt: ActionReceipt,
  vault: Address,
  eventName: "Deposit" | "Withdraw",
  owner: Address,
): Record<string, unknown> | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: erc4626Abi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== eventName) {
        continue;
      }

      const args = decoded.args as unknown as Record<string, unknown>;
      const eventOwner = args["owner"];

      if (typeof eventOwner === "string" && eventOwner.toLowerCase() === owner.toLowerCase()) {
        return args;
      }
    } catch {
      // Not one of ours. Other contracts in the same transaction emit their own logs.
    }
  }

  return null;
}
