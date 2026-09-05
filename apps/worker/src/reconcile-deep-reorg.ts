import {
  createDatabase,
  invalidateOrphanedBlock,
  listPromotedBlockHashes,
  readApplicationCursor,
  rewindApplicationCursor,
  type Database,
  type InvalidationResult,
  type OrphanedBlock,
} from "@tr4ce/db";
import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";

import { BASE_NETWORK, readEnvironment, STREAM_KEY } from "./config.js";
import { getBlockHash } from "./rpc.js";

/**
 * Detect and repair a reorg that ran deeper than the confirmation depth.
 *
 * Promotion is bounded so that ordinary reorgs are removed by the sink before anything is
 * promoted. This is the path for the case that bound does not cover: a reorg deeper than
 * `confirmation_depth`, after rows have already been promoted and reports may already cite them.
 *
 * Repair is append-only. Orphaned observations are flipped to `canonical = false` and every report
 * resting on them is invalidated with a recorded reason; nothing is deleted, because a user who
 * was shown an answer is owed the record that it was withdrawn and why (ERD section 11).
 */

export interface ReconcileOptions {
  db: Database;
  chainId: number;
  /** Resolves the hash the chain currently reports at a height. Null when the block is unknown. */
  canonicalHashAt: (blockNumber: number) => Promise<string | null>;
  /** How far back to re-verify. Defaults to the manifest window start. */
  fromBlock?: number;
}

export interface ReconcileOutcome {
  checked: number;
  orphaned: OrphanedBlock[];
  invalidated: InvalidationResult;
  /** Block the promotion cursor was rewound to, so the range is promoted again. */
  rewoundTo: number | null;
}

export async function reconcileDeepReorg(options: ReconcileOptions): Promise<ReconcileOutcome> {
  const { db, chainId, canonicalHashAt } = options;
  const fromBlock =
    options.fromBlock ??
    Math.min(...baseUsdcVaultManifest.vaults.map((entry) => Number(entry.windowStartBlock)));

  const promoted = await listPromotedBlockHashes(db, chainId, fromBlock);
  const orphaned: OrphanedBlock[] = [];

  for (const entry of promoted) {
    const canonicalBlockHash = await canonicalHashAt(entry.blockNumber);

    if (canonicalBlockHash === null) {
      // The provider cannot answer for a block we have already promoted. That is a provider
      // problem, not evidence of a reorg, and inventing an invalidation from it would destroy
      // good evidence on a bad connection.
      throw new Error(
        `Provider returned no block at ${entry.blockNumber}, which has promoted observations; refusing to infer a reorg from a missing answer.`,
      );
    }

    if (canonicalBlockHash !== entry.blockHash.toLowerCase()) {
      orphaned.push({
        blockNumber: entry.blockNumber,
        orphanedBlockHash: entry.blockHash,
        canonicalBlockHash,
      });
    }
  }

  if (orphaned.length === 0) {
    return {
      checked: promoted.length,
      orphaned: [],
      invalidated: { flows: 0, snapshots: 0, reports: 0 },
      rewoundTo: null,
    };
  }

  const shallowest = orphaned.reduce((lowest, candidate) =>
    candidate.blockNumber < lowest.blockNumber ? candidate : lowest,
  );

  return db.transaction(async (tx) => {
    const totals: InvalidationResult = { flows: 0, snapshots: 0, reports: 0 };

    for (const orphan of orphaned) {
      const result = await invalidateOrphanedBlock(tx, chainId, orphan);

      totals.flows += result.flows;
      totals.snapshots += result.snapshots;
      totals.reports += result.reports;
    }

    // Rewind to the block just below the shallowest orphan, so the replacement chain is promoted
    // over the whole affected range. The anchor's hash is read from the chain rather than carried
    // over from the old cursor: the cursor's hash is a claim about the block it names, and reusing
    // the previous one would attach the hash of a different block to it.
    const cursor = await readApplicationCursor(tx, chainId, STREAM_KEY);
    let rewoundTo: number | null = null;

    if (cursor !== null && cursor.blockNumber >= shallowest.blockNumber) {
      const anchorBlock = Math.max(shallowest.blockNumber - 1, 0);
      const anchorHash = await canonicalHashAt(anchorBlock);

      if (anchorHash === null) {
        throw new Error(
          `Provider returned no block at ${anchorBlock}; cannot rewind the cursor to a position it can attest to.`,
        );
      }

      await rewindApplicationCursor(tx, {
        chainId,
        streamKey: STREAM_KEY,
        blockNumber: anchorBlock,
        blockHash: anchorHash,
        schemaVersion: cursor.schemaVersion,
      });

      rewoundTo = anchorBlock;
    }

    return { checked: promoted.length, orphaned, invalidated: totals, rewoundTo };
  });
}

async function main(): Promise<void> {
  const environment = readEnvironment();
  const { db, close } = createDatabase(environment.databaseUrl);

  try {
    const outcome = await reconcileDeepReorg({
      db,
      chainId: BASE_NETWORK.chainId,
      canonicalHashAt: (blockNumber) => getBlockHash(environment.rpcUrl, blockNumber),
    });

    console.log(`checked ${outcome.checked} promoted block(s)`);

    if (outcome.orphaned.length === 0) {
      console.log("no deep reorg detected");
      return;
    }

    for (const orphan of outcome.orphaned) {
      console.log(
        `orphaned block ${orphan.blockNumber}: promoted ${orphan.orphanedBlockHash}, chain now ${orphan.canonicalBlockHash}`,
      );
    }

    console.log(
      `invalidated ${outcome.invalidated.flows} flow(s), ${outcome.invalidated.snapshots} snapshot(s), ${outcome.invalidated.reports} report(s)`,
    );
    console.log(`cursor rewound to ${outcome.rewoundTo ?? "unchanged"}`);
  } finally {
    await close();
  }
}

if (process.argv[1]?.endsWith("reconcile-deep-reorg.js") === true) {
  await main();
}
