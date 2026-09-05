import {
  createDatabase,
  loadVaultLookup,
  promoteRange,
  promotionCeiling,
  readApplicationCursor,
  readNetwork,
  readSinkHead,
  seedRegistry,
  writeApplicationCursor,
  type Database,
  type PromoteRangeResult,
} from "@tr4ce/db";
import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";

import {
  ACCEPTED_SCHEMA_VERSIONS,
  BASE_NETWORK,
  PROTOCOL_SEEDS,
  readEnvironment,
  STREAM_KEY,
} from "./config.js";
import { getBlockHash, getBlockNumber } from "./rpc.js";

/**
 * Promote confirmed raw rows into the application schema.
 *
 * The whole job is one bounded copy plus one cursor write, committed together. The bound is the
 * point: nothing above `min(sink head, rpc head - confirmation depth)` is ever read, so anything
 * the sink might still undo during a pre-confirmation reorg has never been promoted, and the
 * sink's undo never has to contend with a report's foreign key.
 */

export interface PromoteOptions {
  db: Database;
  chainId: number;
  rpcHead: number;
  /**
   * The canonical hash at a block. The cursor stores the hash of the block it advanced to, so a
   * later reconciliation can tell whether the chain still agrees with where promotion left off.
   */
  canonicalHashAt: (blockNumber: number) => Promise<string | null>;
  /** Cap on how many blocks one run advances, so a cold start commits in bounded batches. */
  maxBlocksPerRun?: number;
}

export interface PromoteOutcome {
  /** Null when nothing could be promoted: no ceiling yet, or already caught up. */
  range: { fromBlock: number; toBlock: number } | null;
  promoted: PromoteRangeResult | null;
  ceiling: number | null;
  cursorAdvancedTo: number | null;
}

const DEFAULT_MAX_BLOCKS_PER_RUN = 100_000;

export interface RangeInput {
  /** Last block already promoted, or null on a cold start. */
  cursorBlock: number | null;
  /** Highest block promotion may touch, from `promotionCeiling`. */
  ceiling: number;
  /** Earliest block any curated vault declares an observation window from. */
  windowStart: number;
  maxBlocksPerRun: number;
}

/**
 * Which blocks this run covers.
 *
 * A cold start begins at the manifest window start rather than block zero: the window is what the
 * manifest attests to, and blocks before it were never indexed, so scanning them would cost a full
 * table scan to find nothing. Returns null when there is nothing left to do.
 */
export function nextRange(input: RangeInput): { fromBlock: number; toBlock: number } | null {
  const fromBlock = input.cursorBlock === null ? input.windowStart : input.cursorBlock + 1;
  const toBlock = Math.min(input.ceiling, fromBlock + input.maxBlocksPerRun - 1);

  return toBlock < fromBlock ? null : { fromBlock, toBlock };
}

export async function promoteConfirmed(options: PromoteOptions): Promise<PromoteOutcome> {
  const { db, chainId, rpcHead } = options;
  const maxBlocks = options.maxBlocksPerRun ?? DEFAULT_MAX_BLOCKS_PER_RUN;

  const networkRow = await readNetwork(db, chainId);

  if (networkRow === null) {
    throw new Error(`Chain ${chainId} is not in the registry; seed it before promoting.`);
  }

  const sinkHead = await readSinkHead(db);
  const ceiling = promotionCeiling({
    rpcHead,
    confirmationDepth: networkRow.confirmationDepth,
    sinkHead,
  });

  if (ceiling === null) {
    return { range: null, promoted: null, ceiling: null, cursorAdvancedTo: null };
  }

  const cursor = await readApplicationCursor(db, chainId, STREAM_KEY);
  const range = nextRange({
    cursorBlock: cursor === null ? null : cursor.blockNumber,
    ceiling,
    windowStart: Math.min(
      ...baseUsdcVaultManifest.vaults.map((entry) => Number(entry.windowStartBlock)),
    ),
    maxBlocksPerRun: maxBlocks,
  });

  if (range === null) {
    return { range: null, promoted: null, ceiling, cursorAdvancedTo: null };
  }

  const { fromBlock, toBlock } = range;

  const lookup = await loadVaultLookup(db, chainId);

  /*
   * The cursor records how far this consumer has scanned, and the hash of the block it stopped at.
   *
   * It has to be the range end rather than the last block that produced a row: the indexed set is
   * sparse — a checkpoint every 1800 blocks, activity only where a vault was touched — so a cursor
   * that only moved on observed blocks would sit forever re-scanning an empty range and never
   * reach the blocks that do hold data.
   *
   * Fetched before the transaction opens, so the transaction holds no locks across a network call.
   * Below the confirmed head the answer is stable by construction.
   */
  const cursorHash = await options.canonicalHashAt(toBlock);

  if (cursorHash === null) {
    // No hash means nothing to attest the cursor position with. Advancing anyway would record a
    // claim about a block this worker never saw.
    throw new Error(`Provider returned no block at ${toBlock}; refusing to advance the cursor.`);
  }

  // One transaction for the rows and the cursor. Any validation failure inside throws, the
  // transaction rolls back, and the cursor stays exactly where it was so the next run reprocesses
  // this same range instead of stepping over it.
  return db.transaction(async (tx) => {
    const promoted = await promoteRange(tx, {
      chainId,
      fromBlock,
      toBlock,
      lookup,
      acceptedSchemaVersions: ACCEPTED_SCHEMA_VERSIONS,
    });

    await writeApplicationCursor(tx, {
      chainId,
      streamKey: STREAM_KEY,
      blockNumber: toBlock,
      blockHash: cursorHash,
      schemaVersion: promoted.attested?.schemaVersion ?? ACCEPTED_SCHEMA_VERSIONS[0]!,
    });

    return { range: { fromBlock, toBlock }, promoted, ceiling, cursorAdvancedTo: toBlock };
  });
}

async function main(): Promise<void> {
  const environment = readEnvironment();
  const { db, close } = createDatabase(environment.databaseUrl);

  try {
    const seeded = await db.transaction((tx) =>
      seedRegistry(tx, {
        manifest: baseUsdcVaultManifest,
        network: BASE_NETWORK,
        protocols: PROTOCOL_SEEDS,
      }),
    );

    console.log(
      `registry: ${seeded.vaults} vaults, ${seeded.capabilities} capability profiles, ${seeded.assets} assets`,
    );

    const rpcHead = await getBlockNumber(environment.rpcUrl);
    const totals = { deposits: 0, withdrawals: 0, shareTransfers: 0, snapshots: 0 };
    let ceiling: number | null = null;
    let last: number | null = null;

    // Run until caught up. A cold start spans the whole declared window, and committing it as one
    // transaction would put the entire backfill at risk of a single failure.
    for (;;) {
      const outcome: PromoteOutcome = await promoteConfirmed({
        db,
        chainId: BASE_NETWORK.chainId,
        rpcHead,
        canonicalHashAt: (blockNumber) => getBlockHash(environment.rpcUrl, blockNumber),
      });

      ceiling = outcome.ceiling;

      if (outcome.range === null || outcome.promoted === null) {
        break;
      }

      totals.deposits += outcome.promoted.deposits;
      totals.withdrawals += outcome.promoted.withdrawals;
      totals.shareTransfers += outcome.promoted.shareTransfers;
      totals.snapshots += outcome.promoted.snapshots;
      last = outcome.cursorAdvancedTo;

      console.log(
        `  ${outcome.range.fromBlock}..${outcome.range.toBlock}: ` +
          `${outcome.promoted.deposits} deposits, ${outcome.promoted.withdrawals} withdrawals, ` +
          `${outcome.promoted.shareTransfers} share transfers, ${outcome.promoted.snapshots} snapshots`,
      );
    }

    console.log(
      `promoted ${totals.deposits} deposits, ${totals.withdrawals} withdrawals, ` +
        `${totals.shareTransfers} share transfers, ${totals.snapshots} snapshots`,
    );
    console.log(
      `cursor: ${last ?? "unchanged"} (rpc head ${rpcHead}, ceiling ${ceiling ?? "none"})`,
    );
  } finally {
    await close();
  }
}

if (process.argv[1]?.endsWith("promote-confirmed.js") === true) {
  await main();
}
