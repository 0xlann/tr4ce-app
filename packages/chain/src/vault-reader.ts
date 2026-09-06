import type { CapabilityMethod } from "@tr4ce/domain";
import { createPublicClient, http, type Address, type Hex, type HttpTransport, type PublicClient } from "viem";
import { base } from "viem/chains";

import { erc4626Abi } from "./abis.js";

/**
 * Block-scoped ERC-4626 reads, recorded exactly as the chain answered.
 *
 * This layer performs no interpretation whatsoever. A revert is stored as a revert, a zero as a
 * zero, and nothing is substituted for a call that produced nothing — `capabilities.ts` decides
 * what any of it means. The separation is required by Task 5's checklist ("preserve call
 * value/revert and adapter interpretation separately") for a concrete reason: an adapter may explain
 * a protocol's known behaviour, but the raw observation has to survive alongside the explanation so
 * a reader can check one against the other.
 *
 * This is the TypeScript twin of `snapshots.rs` in the Substreams package, which applies the same
 * rule to the same methods at indexing time.
 */

/** One call's outcome. Never collapsed into `bigint | null` — the failure detail is evidence. */
export type ReadOutcome =
  | { ok: true; value: bigint }
  | { ok: false; revertData: Hex | null; message: string };

export type AddressReadOutcome =
  | { ok: true; value: Address }
  | { ok: false; revertData: Hex | null; message: string };

export interface VaultReadRequest {
  vault: Address;
  /** Exact block. Never omitted: a silent fall back to `latest` would mislabel the observation. */
  blockNumber: bigint;
  /** One whole share, `10^shareDecimals`, the unit `convertToAssets` is quoted in. */
  oneShareUnits: bigint;
  /** Account whose limits are probed. Omit to skip the account-scoped reads. */
  owner?: Address;
  /** Asset amount used for `previewDeposit`. Defaults to one whole asset unit. */
  previewAssets?: bigint;
}

/** Every read, keyed by the method that produced it. Absent means the call was not attempted. */
export interface VaultReadResults {
  vault: Address;
  blockNumber: bigint;
  asset: AddressReadOutcome;
  decimals: ReadOutcome;
  totalAssets: ReadOutcome;
  totalSupply: ReadOutcome;
  convertToAssets: ReadOutcome;
  maxWithdraw: ReadOutcome | null;
  maxRedeem: ReadOutcome | null;
  previewDeposit: ReadOutcome;
  previewRedeem: ReadOutcome;
  /** The owner's share balance, needed to tell a documented non-standard zero from an honest one. */
  ownerShares: ReadOutcome | null;
}

/**
 * A client pinned to Base.
 *
 * Named rather than left as the bare `PublicClient`, because the chain is not decoration: viem
 * reads the Multicall3 address from it, and the generic type would not carry that.
 */
export type ChainClient = PublicClient<HttpTransport, typeof base>;

/**
 * Open a read-only client. No signer is ever attached; this package cannot send a transaction.
 *
 * Reads are batched through Multicall3, which matters for correctness as much as for cost. Every
 * read for one observation then executes inside a single call at a single block, so the snapshot
 * cannot be stitched together from calls that landed at different heights. It is also the same
 * shape the Substreams module already uses for its block-scoped reads.
 *
 * Practically, it is what makes these reads survive a public endpoint: issuing the methods
 * separately gets the burst rate-limited, and a rate-limited read is indistinguishable from a
 * revert unless you look closely — the worst possible failure for a package whose whole job is to
 * record why a call produced nothing.
 */
export function createChainClient(rpcUrl: string): ChainClient {
  return createPublicClient({
    // The chain is required for batching: viem takes the Multicall3 address from it, and silently
    // falls back to one request per read without it.
    chain: base,
    transport: http(rpcUrl, { retryCount: 5, retryDelay: 300 }),
    batch: { multicall: true },
  });
}

/**
 * Read every ERC-4626 method the product depends on, at one exact block.
 *
 * Each call is isolated so one revert cannot take the others down with it — a vault where
 * `maxWithdraw` reverts must still yield its `totalAssets`. That mirrors the per-method failure
 * handling the Substreams module already applies to its batched block-scoped calls.
 */
export async function readVaultAt(
  client: ChainClient,
  request: VaultReadRequest,
): Promise<VaultReadResults> {
  const { vault, blockNumber, oneShareUnits, owner } = request;
  const previewAssets = request.previewAssets ?? 1_000_000n;

  const call = <T>(fn: () => Promise<T>) => attempt(fn);

  const [
    asset,
    decimals,
    totalAssets,
    totalSupply,
    convertToAssets,
    previewDeposit,
    previewRedeem,
  ] = await Promise.all([
    call(() =>
      client.readContract({ address: vault, abi: erc4626Abi, functionName: "asset", blockNumber }),
    ),
    call(() =>
      client.readContract({ address: vault, abi: erc4626Abi, functionName: "decimals", blockNumber }),
    ),
    call(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "totalAssets",
        blockNumber,
      }),
    ),
    call(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "totalSupply",
        blockNumber,
      }),
    ),
    call(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "convertToAssets",
        args: [oneShareUnits],
        blockNumber,
      }),
    ),
    call(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "previewDeposit",
        args: [previewAssets],
        blockNumber,
      }),
    ),
    call(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "previewRedeem",
        args: [oneShareUnits],
        blockNumber,
      }),
    ),
  ]);

  const accountReads =
    owner === undefined
      ? { maxWithdraw: null, maxRedeem: null, ownerShares: null }
      : await readAccountScoped(client, vault, owner, blockNumber);

  return {
    vault,
    blockNumber,
    asset: toAddressOutcome(asset),
    decimals: toNumericOutcome(decimals),
    totalAssets: toNumericOutcome(totalAssets),
    totalSupply: toNumericOutcome(totalSupply),
    convertToAssets: toNumericOutcome(convertToAssets),
    previewDeposit: toNumericOutcome(previewDeposit),
    previewRedeem: toNumericOutcome(previewRedeem),
    ...accountReads,
  };
}

async function readAccountScoped(
  client: ChainClient,
  vault: Address,
  owner: Address,
  blockNumber: bigint,
): Promise<Pick<VaultReadResults, "maxWithdraw" | "maxRedeem" | "ownerShares">> {
  const [maxWithdraw, maxRedeem, ownerShares] = await Promise.all([
    attempt(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "maxWithdraw",
        args: [owner],
        blockNumber,
      }),
    ),
    attempt(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "maxRedeem",
        args: [owner],
        blockNumber,
      }),
    ),
    attempt(() =>
      client.readContract({
        address: vault,
        abi: erc4626Abi,
        functionName: "balanceOf",
        args: [owner],
        blockNumber,
      }),
    ),
  ]);

  return {
    maxWithdraw: toNumericOutcome(maxWithdraw),
    maxRedeem: toNumericOutcome(maxRedeem),
    ownerShares: toNumericOutcome(ownerShares),
  };
}

/**
 * The timestamp of a block.
 *
 * Lives here because the policy evaluator needs the vault's deployment time to tell a vault that is
 * too young (FAIL) from history we simply have not indexed (UNKNOWN), and the manifest records only
 * a deployment block number. `packages/policy` is pure and cannot resolve one to the other.
 */
export async function blockTimestamp(
  client: ChainClient,
  blockNumber: bigint,
): Promise<string | null> {
  try {
    const block = await client.getBlock({ blockNumber });

    return new Date(Number(block.timestamp) * 1000).toISOString();
  } catch {
    // A provider that cannot answer is not evidence that the block does not exist.
    return null;
  }
}

type Attempt<T> = { ok: true; value: T } | { ok: false; revertData: Hex | null; message: string };

/** Run one call, converting any failure into a recorded outcome rather than a thrown error. */
async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return {
      ok: false,
      revertData: extractRevertData(error),
      message: error instanceof Error ? error.message.split("\n")[0]! : String(error),
    };
  }
}

/** Pull the raw revert payload out of a viem error, so the report can show what the chain returned. */
function extractRevertData(error: unknown): Hex | null {
  const candidate = error as { data?: unknown; cause?: { data?: unknown } };
  const data = candidate?.data ?? candidate?.cause?.data;

  return typeof data === "string" && data.startsWith("0x") ? (data as Hex) : null;
}

function toNumericOutcome(outcome: Attempt<unknown>): ReadOutcome {
  if (!outcome.ok) {
    return outcome;
  }

  return typeof outcome.value === "bigint"
    ? { ok: true, value: outcome.value }
    : { ok: true, value: BigInt(outcome.value as number) };
}

function toAddressOutcome(outcome: Attempt<unknown>): AddressReadOutcome {
  return outcome.ok ? { ok: true, value: outcome.value as Address } : outcome;
}

/** Methods this reader covers, for the capability classifier to iterate. */
export const READ_METHODS: readonly CapabilityMethod[] = [
  "asset",
  "decimals",
  "totalAssets",
  "totalSupply",
  "convertToAssets",
  "maxWithdraw",
  "maxRedeem",
  "previewDeposit",
  "previewRedeem",
];
