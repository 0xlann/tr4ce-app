import { bigint, boolean, integer, numeric, pgTable, primaryKey, smallint, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Read-only mirror of the sink-owned staging tables in substreams/erc4626/schema.sql.
 *
 * TR4CE never writes these: the built-in PostgreSQL Database Changes sink creates them, inserts
 * into them, and deletes from them while undoing a pre-confirmation reorg. They are declared here
 * only so the promotion worker can read them with the same type safety as everything else, and any
 * drift between this file and schema.sql surfaces as a failing integration test rather than a
 * runtime cast error.
 *
 * Two shape differences from the application schema are inherited from the sink and are not
 * mistakes to be tidied up:
 *
 *   - hashes and addresses are `VARCHAR` `0x` text, not `bytea`; the sink emits text literals
 *   - `call_errors` is TEXT, not JSONB; the sink writes a JSONB value unquoted, which produces
 *     `VALUES (..., [], ...)` and a SQL syntax error
 *
 * The promotion worker converts both exactly once, on the way in.
 */

const rawEventColumns = {
  chainId: bigint("chain_id", { mode: "number" }).notNull(),
  blockHash: varchar("block_hash", { length: 66 }).notNull(),
  transactionHash: varchar("transaction_hash", { length: 66 }).notNull(),
  logIndex: integer("log_index").notNull(),
  blockNumber: bigint("block_number", { mode: "number" }).notNull(),
  blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
  vault: varchar("vault", { length: 42 }).notNull(),
  schemaVersion: text("schema_version").notNull(),
} as const;

export const rawDeposit = pgTable(
  "raw_erc4626_deposit",
  {
    ...rawEventColumns,
    sender: varchar("sender", { length: 42 }).notNull(),
    owner: varchar("owner", { length: 42 }).notNull(),
    assets: numeric("assets", { precision: 78, scale: 0 }).notNull(),
    shares: numeric("shares", { precision: 78, scale: 0 }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.chainId, table.blockHash, table.transactionHash, table.logIndex],
    }),
  ],
);

export const rawWithdraw = pgTable(
  "raw_erc4626_withdraw",
  {
    ...rawEventColumns,
    sender: varchar("sender", { length: 42 }).notNull(),
    receiver: varchar("receiver", { length: 42 }).notNull(),
    owner: varchar("owner", { length: 42 }).notNull(),
    assets: numeric("assets", { precision: 78, scale: 0 }).notNull(),
    shares: numeric("shares", { precision: 78, scale: 0 }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.chainId, table.blockHash, table.transactionHash, table.logIndex],
    }),
  ],
);

export const rawShareTransfer = pgTable(
  "raw_erc4626_share_transfer",
  {
    ...rawEventColumns,
    fromAddress: varchar("from_address", { length: 42 }).notNull(),
    toAddress: varchar("to_address", { length: 42 }).notNull(),
    shares: numeric("shares", { precision: 78, scale: 0 }).notNull(),
    transferKind: text("transfer_kind").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.chainId, table.blockHash, table.transactionHash, table.logIndex],
    }),
  ],
);

export const rawVaultSnapshot = pgTable(
  "raw_erc4626_vault_snapshot",
  {
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    vault: varchar("vault", { length: 42 }).notNull(),
    blockHash: varchar("block_hash", { length: 66 }).notNull(),
    schemaVersion: text("schema_version").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    asset: varchar("asset", { length: 42 }).notNull(),
    shareDecimals: smallint("share_decimals").notNull(),
    assetDecimals: smallint("asset_decimals").notNull(),
    totalAssets: numeric("total_assets", { precision: 78, scale: 0 }),
    totalSupply: numeric("total_supply", { precision: 78, scale: 0 }),
    oneShareUnits: numeric("one_share_units", { precision: 78, scale: 0 }).notNull(),
    oneShareAssets: numeric("one_share_assets", { precision: 78, scale: 0 }),
    callStatus: text("call_status").notNull(),
    callErrors: text("call_errors").notNull(),
    triggerActivity: boolean("trigger_activity").notNull(),
    triggerCheckpoint: boolean("trigger_checkpoint").notNull(),
    triggerAnchor: boolean("trigger_anchor").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.vault, table.blockHash, table.schemaVersion] }),
  ],
);

/**
 * The sink's own cursor table.
 *
 * One row per module hash, holding the last block the sink committed to staging. The promotion
 * worker treats `block_num` as a hard ceiling: promoting past it would promote rows the sink has
 * not written yet.
 */
export const sinkCursor = pgTable("cursors", {
  id: text("id").primaryKey(),
  cursor: text("cursor").notNull(),
  blockNum: bigint("block_num", { mode: "number" }).notNull(),
  blockId: text("block_id").notNull(),
});
