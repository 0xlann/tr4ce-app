import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bytea } from "./columns.js";
import { wallet } from "./policies.js";
import { vault } from "./registry.js";
import { evidenceReport } from "./reports.js";

/**
 * Prepared actions — ERD.md section 7.
 *
 * "No signature is stored." There is no column for one here, and no code path upstream that could
 * produce one: @tr4ce/chain carries no signer and a test in that package fails if any source file
 * names viem's wallet half. A transaction hash arrives only because a caller reports it after their
 * own wallet submitted (PRD TR-F-043).
 */

export const preparedAction = pgTable(
  "prepared_action",
  {
    /**
     * `act_` plus 32 generated hex.
     *
     * Not content-derived, unlike a report id: an action is an intent to spend, and repeating one
     * is legitimate. Idempotency lives on `prepared_action_live_binding_key` instead, which covers
     * only actions still awaiting a signature.
     */
    id: text("id").primaryKey(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallet.id),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    /** Nullable: an action can be prepared without a report having asked for it. */
    reportId: text("report_id").references(() => evidenceReport.id),
    kind: text("kind").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    account: bytea("account").notNull(),
    /** The action digest: chain, account, every call, capability version. Never the block. */
    calldataHash: bytea("calldata_hash").notNull(),
    /** The seventh bound field. Kept so a later simulation binds to the same interpretation. */
    capabilityVersion: text("capability_version").notNull(),
    /** Every unsigned call in signing order — one or two, depending on the observed allowance. */
    transactionsJson: jsonb("transactions_json").notNull(),
    /** How many of those calls the caller has reported a hash for. */
    sentCount: integer("sent_count").notNull().default(0),
    /** Shares for a deposit, assets for a redemption. A preview, never a promise. */
    previewedAmount: numeric("previewed_amount", { precision: 78, scale: 0 }).notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    invalidatedReason: text("invalidated_reason"),
  },
  (table) => [
    index("prepared_action_wallet_idx").on(table.walletId, table.createdAt),
    index("prepared_action_vault_idx").on(table.vaultId, table.createdAt),
    index("prepared_action_report_idx").on(table.reportId),
    uniqueIndex("prepared_action_live_binding_key")
      .on(table.calldataHash)
      .where(sql`status IN ('prepared', 'simulated')`),
  ],
);

/**
 * Append-only simulation attempts.
 *
 * A resimulation adds a row rather than replacing one: "was this ever simulated successfully, and
 * against which block" has to stay answerable after the action expires.
 */
export const simulation = pgTable(
  "simulation",
  {
    id: uuid("id").primaryKey(),
    preparedActionId: text("prepared_action_id")
      .notNull()
      .references(() => preparedAction.id),
    /** Which of the action's calls this attempt covered. */
    callIndex: integer("call_index").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    blockHash: bytea("block_hash").notNull(),
    account: bytea("account").notNull(),
    success: boolean("success").notNull(),
    /** NULL for a call that reverted. A zero would read as a free transaction. */
    gasEstimate: numeric("gas_estimate", { precision: 78, scale: 0 }),
    returnDataHash: bytea("return_data_hash"),
    decodedResultJson: jsonb("decoded_result_json"),
    revertClass: text("revert_class").notNull(),
    /** Names the provider, never a credential. */
    providerKey: text("provider_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("simulation_action_idx").on(table.preparedActionId, table.createdAt)],
);

/**
 * What the wallet did with one call of a prepared action.
 *
 * Written only when a caller reports a hash. If the user signs and walks away, there is simply no
 * row — TR4CE does not poll for one, because polling would mean tracking transactions it never
 * agreed to be responsible for.
 *
 * Keyed per call rather than per action: an approve-plus-deposit pair produces two hashes, and one
 * row per action would leave the second nowhere to go.
 */
export const transactionReceipt = pgTable(
  "transaction_receipt",
  {
    preparedActionId: text("prepared_action_id")
      .notNull()
      .references(() => preparedAction.id),
    callIndex: integer("call_index").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    transactionHash: bytea("transaction_hash").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    /** All four confirmation columns move together, enforced by a CHECK in the migration. */
    confirmedBlockNumber: numeric("confirmed_block_number", { precision: 78, scale: 0 }),
    confirmedBlockHash: bytea("confirmed_block_hash"),
    status: text("status"),
    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }),
    effectiveGasPrice: numeric("effective_gas_price", { precision: 78, scale: 0 }),
    /** What the vault's event reported. Null when none was found; never the preview. */
    actualAmount: numeric("actual_amount", { precision: 78, scale: 0 }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.preparedActionId, table.callIndex] }),
    uniqueIndex("transaction_receipt_hash_key").on(table.chainId, table.transactionHash),
  ],
);

export const preparedActionRelations = relations(preparedAction, ({ one, many }) => ({
  wallet: one(wallet, { fields: [preparedAction.walletId], references: [wallet.id] }),
  vault: one(vault, { fields: [preparedAction.vaultId], references: [vault.id] }),
  report: one(evidenceReport, {
    fields: [preparedAction.reportId],
    references: [evidenceReport.id],
  }),
  simulations: many(simulation),
}));

export const simulationRelations = relations(simulation, ({ one }) => ({
  action: one(preparedAction, {
    fields: [simulation.preparedActionId],
    references: [preparedAction.id],
  }),
}));

export const transactionReceiptRelations = relations(transactionReceipt, ({ one }) => ({
  action: one(preparedAction, {
    fields: [transactionReceipt.preparedActionId],
    references: [preparedAction.id],
  }),
}));
