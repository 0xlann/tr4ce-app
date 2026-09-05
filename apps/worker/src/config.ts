import type { ProtocolSeed } from "@tr4ce/db";

/**
 * Worker configuration.
 *
 * Everything that identifies a vault comes from the verified manifest. What lives here is only
 * operational: which chain, how deep confirmation runs, and display metadata for protocols the
 * manifest names by slug.
 */

/** The consumer key written into `indexer_cursor.stream_key`. */
export const STREAM_KEY = "erc4626-promotion";

/**
 * Producer schema versions this worker knows how to read.
 *
 * A raw batch carrying anything else is rejected with the cursor untouched, rather than being
 * interpreted under the wrong assumptions (ARCHITECTURE.md section 9).
 */
export const ACCEPTED_SCHEMA_VERSIONS = ["1.0.0"] as const;

/**
 * Blocks below the RPC head before a row may be promoted.
 *
 * Base has ~2s blocks and reaches finality well inside this, so 64 blocks is roughly two minutes
 * of lag for a margin far past any reorg observed in practice. It is an operational setting, not a
 * safety guarantee, and it is stored on `network` so changing it does not require a deploy.
 */
export const BASE_CONFIRMATION_DEPTH = 64;

export const BASE_NETWORK = {
  chainId: 8453,
  slug: "base",
  name: "Base",
  nativeSymbol: "ETH",
  confirmationDepth: BASE_CONFIRMATION_DEPTH,
} as const;

/**
 * Display metadata for the protocols the manifest references by slug.
 *
 * Never used for identity: which protocol operates a vault is decided by the curated address and
 * the verified code hash, not by anything here.
 */
export const PROTOCOL_SEEDS: readonly ProtocolSeed[] = [
  {
    slug: "morpho-blue",
    name: "Morpho",
    documentationUrl: "https://docs.morpho.org",
  },
  {
    slug: "yearn-v3",
    name: "Yearn V3",
    documentationUrl: "https://docs.yearn.fi",
  },
];

export interface WorkerEnvironment {
  databaseUrl: string;
  rpcUrl: string;
}

export function readEnvironment(): WorkerEnvironment {
  const databaseUrl = process.env["DATABASE_URL"];
  const rpcUrl = process.env["RPC_URL_BASE"];

  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required.");
  }

  if (rpcUrl === undefined || rpcUrl === "") {
    throw new Error("RPC_URL_BASE is required: the confirmed head cannot be guessed.");
  }

  return { databaseUrl, rpcUrl };
}
