import { encodeFunctionData, type Address, type Hex } from "viem";

import { erc20Abi, erc4626Abi } from "./abis.js";
import type { ChainClient } from "./vault-reader.js";

/**
 * Building the exact calls an ERC-4626 deposit or redemption needs.
 *
 * Nothing here signs or submits, and nothing here can: the client this module takes carries no
 * account (see `createChainClient`), and `abis.test.ts` fails if any file in this package so much
 * as names viem's wallet half. A prepared action is a proposal the wallet owner approves one
 * transaction at a time (PRD TR-F-036, TR-F-043).
 *
 * Preconditions are checked before calldata is built, and a failed one is returned as a reason
 * rather than thrown. A caller needs to show the user *why* an action is unavailable, and an
 * exception carrying a string is a worse way to say "your balance is short" than a reason code is.
 */

/** One unsigned call, in the order it must be signed. */
export interface PreparedCall {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
  /** What this call does, for a UI that has to explain a two-step deposit. */
  kind: "approve" | "deposit" | "redeem";
}

export type PrepareFailure =
  | { code: "AMOUNT_NOT_POSITIVE" }
  | { code: "ASSET_MISMATCH"; declared: Address; observed: Address | null }
  | { code: "INSUFFICIENT_BALANCE"; required: bigint; available: bigint | null }
  | { code: "LIMIT_EXCEEDED"; requested: bigint; limit: bigint }
  | { code: "PREVIEW_UNAVAILABLE" }
  | { code: "PREVIEW_ZERO" }
  | { code: "READ_FAILED"; method: string };

export type PrepareResult<T> = { ok: true; value: T } | { ok: false; failure: PrepareFailure };

export interface DepositRequest {
  vault: Address;
  /** The asset the registry says this vault holds. Checked against `vault.asset()`, never assumed. */
  asset: Address;
  owner: Address;
  receiver: Address;
  assets: bigint;
}

export interface PreparedDeposit {
  calls: PreparedCall[];
  /** Shares `previewDeposit` expects. A preview, never a promise (SMART-CONTRACT.md section 4). */
  previewedShares: bigint;
  /** Allowance observed before preparing. Explains why an approval is or is not in `calls`. */
  allowance: bigint;
  /** `maxDeposit(receiver)`, or null when the vault does not answer. Null never means zero. */
  maxDeposit: bigint | null;
}

/**
 * Prepare an exact approval and a deposit.
 *
 * The approval is conditional and its absence is evidence, not an omission: when the owner has
 * already allowed the vault at least this much, a second `approve` would be a transaction the user
 * pays for and gains nothing from. `allowance` is returned either way so a caller can say which
 * happened.
 *
 * The approval, when present, is for exactly the amount being deposited. TR4CE never requests an
 * unlimited allowance (PRD TR-F-034), and no configuration switch turns that off.
 */
export async function prepareDeposit(
  client: ChainClient,
  request: DepositRequest,
): Promise<PrepareResult<PreparedDeposit>> {
  const { vault, asset, owner, receiver, assets } = request;

  if (assets <= 0n) {
    return { ok: false, failure: { code: "AMOUNT_NOT_POSITIVE" } };
  }

  // Identity first: everything below is meaningless if this vault does not hold the asset the
  // registry attributes to it (SMART-CONTRACT.md section 2 — a ticker never decides what a token
  // is, and neither does our own table).
  const observedAsset = await read(() =>
    client.readContract({ address: vault, abi: erc4626Abi, functionName: "asset" }),
  );

  if (!observedAsset.ok) {
    return { ok: false, failure: { code: "READ_FAILED", method: "asset" } };
  }

  if (observedAsset.value.toLowerCase() !== asset.toLowerCase()) {
    return {
      ok: false,
      failure: { code: "ASSET_MISMATCH", declared: asset, observed: observedAsset.value },
    };
  }

  const [balance, allowance, preview, limit] = await Promise.all([
    read(() =>
      client.readContract({
        address: asset,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
    read(() =>
      client.readContract({
        address: asset,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, vault],
      }),
    ),
    read(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "previewDeposit",
        args: [assets],
      }),
    ),
    read(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "maxDeposit",
        args: [receiver],
      }),
    ),
  ]);

  if (!balance.ok) {
    return { ok: false, failure: { code: "READ_FAILED", method: "balanceOf" } };
  }

  if (balance.value < assets) {
    return {
      ok: false,
      failure: { code: "INSUFFICIENT_BALANCE", required: assets, available: balance.value },
    };
  }

  /*
   * A vault that does not answer `maxDeposit` is not a vault that refuses the deposit.
   * SMART-CONTRACT.md section 4 precondition 6 says an unsupported limit means no automatic
   * assertion — so an unreadable limit stops nothing here, and the simulation is what decides.
   * Treating the missing answer as zero would refuse every deposit into such a vault.
   */
  if (limit.ok && limit.value < assets) {
    return { ok: false, failure: { code: "LIMIT_EXCEEDED", requested: assets, limit: limit.value } };
  }

  if (!preview.ok) {
    return { ok: false, failure: { code: "PREVIEW_UNAVAILABLE" } };
  }

  if (preview.value === 0n) {
    // Depositing for zero shares is a loss, whatever the vault's reason for quoting it.
    return { ok: false, failure: { code: "PREVIEW_ZERO" } };
  }

  const calls: PreparedCall[] = [];
  const observedAllowance = allowance.ok ? allowance.value : 0n;

  if (observedAllowance < assets) {
    calls.push({
      chainId: client.chain.id,
      to: asset,
      // Exactly `assets`. Never type(uint256).max, and no branch here can produce one.
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, assets] }),
      value: "0",
      kind: "approve",
    });
  }

  calls.push({
    chainId: client.chain.id,
    to: vault,
    data: encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [assets, receiver] }),
    value: "0",
    kind: "deposit",
  });

  return {
    ok: true,
    value: {
      calls,
      previewedShares: preview.value,
      allowance: observedAllowance,
      maxDeposit: limit.ok ? limit.value : null,
    },
  };
}

export interface RedeemRequest {
  vault: Address;
  owner: Address;
  receiver: Address;
  shares: bigint;
}

export interface PreparedRedeem {
  calls: PreparedCall[];
  /** Assets `previewRedeem` expects. Compared against the receipt afterwards, never substituted. */
  previewedAssets: bigint;
  shareBalance: bigint;
  /** Both limits with their readability preserved: null is "the vault did not say", not zero. */
  maxRedeem: bigint | null;
  maxWithdraw: bigint | null;
}

/**
 * Prepare a redemption.
 *
 * One call, always: redeeming needs no allowance because the vault burns the owner's own shares.
 */
export async function prepareRedeem(
  client: ChainClient,
  request: RedeemRequest,
): Promise<PrepareResult<PreparedRedeem>> {
  const { vault, owner, receiver, shares } = request;

  if (shares <= 0n) {
    return { ok: false, failure: { code: "AMOUNT_NOT_POSITIVE" } };
  }

  const [balance, preview, maxRedeem, maxWithdraw] = await Promise.all([
    read(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
    read(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "previewRedeem",
        args: [shares],
      }),
    ),
    read(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "maxRedeem",
        args: [owner],
      }),
    ),
    read(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "maxWithdraw",
        args: [owner],
      }),
    ),
  ]);

  if (!balance.ok) {
    return { ok: false, failure: { code: "READ_FAILED", method: "balanceOf" } };
  }

  if (balance.value < shares) {
    return {
      ok: false,
      failure: { code: "INSUFFICIENT_BALANCE", required: shares, available: balance.value },
    };
  }

  if (!preview.ok) {
    return { ok: false, failure: { code: "PREVIEW_UNAVAILABLE" } };
  }

  /*
   * `maxRedeem` returning zero for an owner who demonstrably holds shares is the documented Morpho
   * quirk, and `capabilities.ts` classifies it as `nonstandard_zero` rather than a real limit. It
   * therefore cannot refuse a redemption here: an ambiguous answer is not a refusal, and treating
   * it as one would block a withdrawal the chain would have accepted.
   */
  const ambiguousZero = maxRedeem.ok && maxRedeem.value === 0n && balance.value > 0n;

  if (maxRedeem.ok && !ambiguousZero && maxRedeem.value < shares) {
    return {
      ok: false,
      failure: { code: "LIMIT_EXCEEDED", requested: shares, limit: maxRedeem.value },
    };
  }

  return {
    ok: true,
    value: {
      calls: [
        {
          chainId: client.chain.id,
          to: vault,
          data: encodeFunctionData({
            abi: erc4626Abi,
            functionName: "redeem",
            args: [shares, receiver, owner],
          }),
          value: "0",
          kind: "redeem",
        },
      ],
      previewedAssets: preview.value,
      shareBalance: balance.value,
      maxRedeem: maxRedeem.ok ? maxRedeem.value : null,
      maxWithdraw: maxWithdraw.ok ? maxWithdraw.value : null,
    },
  };
}

type Read<T> = { ok: true; value: T } | { ok: false };

/** One call, with failure turned into an outcome rather than an exception. */
async function read<T>(fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}
