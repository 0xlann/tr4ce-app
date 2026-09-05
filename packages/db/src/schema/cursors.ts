import { bigint, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { bytea } from "./columns.js";

/**
 * The application promotion cursor — ERD.md section 4, `indexer_cursor`.
 *
 * Deliberately not the sink's own `cursors` table. That one records how far the built-in sink has
 * written into raw staging and is rewritten during pre-confirmation reorg handling; this one
 * records how far the worker has promoted into the constrained tables, and only ever moves under
 * the confirmed head.
 *
 * The cursor is committed in the same transaction as the rows it covers. A batch that fails
 * validation leaves the cursor where it was, so the next run reprocesses the same range rather
 * than stepping over it (ARCHITECTURE.md section 9: "preserve cursor before invalid batch").
 */
export const indexerCursor = pgTable(
  "indexer_cursor",
  {
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    /** Which consumer this cursor belongs to, e.g. `erc4626-promotion`. */
    streamKey: text("stream_key").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    /** The exact hash promoted at `block_number`; a mismatch here is how a deep reorg is detected. */
    blockHash: bytea("block_hash").notNull(),
    schemaVersion: text("schema_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.streamKey] })],
);
