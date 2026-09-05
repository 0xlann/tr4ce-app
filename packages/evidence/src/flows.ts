import type { FlowKind, TransferKind } from "@tr4ce/domain";

/**
 * Vault-wide flow aggregation.
 *
 * A report must distinguish what entered and left the vault from how share value moved
 * (PRD TR-F-014). They answer different questions: a vault can gain assets purely through deposits
 * while its share value falls, and collapsing the two hides exactly that case.
 */

/** One promoted `vault_flow` row, reduced to what aggregation needs. */
export interface FlowRow {
  kind: FlowKind;
  /** Only present for `share_transfer`; null for deposits and withdrawals. */
  transferKind: TransferKind | null;
  /** Null by event kind — a share transfer moves no assets. Never read as zero. */
  assets: bigint | null;
  shares: bigint;
  canonical: boolean;
}

export interface FlowAggregate {
  depositedAssets: bigint;
  withdrawnAssets: bigint;
  /** `deposited - withdrawn`. Signed, because a vault can lose more than it takes in. */
  netFlowAssets: bigint;
  depositCount: number;
  withdrawalCount: number;
  /**
   * Share movements seen and deliberately left out of the asset totals, split by why.
   *
   * Recorded rather than dropped so a report can show it excluded them, instead of leaving a
   * reader to wonder whether they were ever seen. Task 3 promotes mints and burns for exactly
   * this purpose.
   */
  excluded: {
    mints: number;
    burns: number;
    transfers: number;
    nonCanonical: number;
    missingAssets: number;
  };
}

/**
 * Sum deposits and withdrawals, excluding everything that would double-count them.
 *
 * Three exclusions, each for a different reason:
 *
 *   - **Share transfers** move no assets at all. A mint is the share side of a deposit already
 *     counted, a burn the share side of a withdrawal; adding them would count the same economic
 *     event twice. A plain wallet-to-wallet transfer moves ownership, not vault assets.
 *   - **Non-canonical rows** were orphaned by a deep reorg. They stay in the table as audit state
 *     and must never reach a live calculation.
 *   - **Rows with a null `assets`** are missing the value being summed. Treating null as zero would
 *     understate flow while looking like a complete answer.
 */
export function aggregateFlows(rows: readonly FlowRow[]): FlowAggregate {
  let depositedAssets = 0n;
  let withdrawnAssets = 0n;
  let depositCount = 0;
  let withdrawalCount = 0;

  const excluded = { mints: 0, burns: 0, transfers: 0, nonCanonical: 0, missingAssets: 0 };

  for (const row of rows) {
    if (!row.canonical) {
      excluded.nonCanonical += 1;
      continue;
    }

    if (row.kind === "share_transfer") {
      if (row.transferKind === "mint") {
        excluded.mints += 1;
      } else if (row.transferKind === "burn") {
        excluded.burns += 1;
      } else {
        excluded.transfers += 1;
      }

      continue;
    }

    if (row.assets === null) {
      excluded.missingAssets += 1;
      continue;
    }

    if (row.kind === "deposit") {
      depositedAssets += row.assets;
      depositCount += 1;
    } else {
      withdrawnAssets += row.assets;
      withdrawalCount += 1;
    }
  }

  return {
    depositedAssets,
    withdrawnAssets,
    netFlowAssets: depositedAssets - withdrawnAssets,
    depositCount,
    withdrawalCount,
    excluded,
  };
}
