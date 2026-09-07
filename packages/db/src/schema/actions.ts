import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
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
    /** `act_` plus a digest of the binding — content-derived, like a report id. */
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
    /** The binding digest. ERD section 7 calls it "immutable action identity". */
    calldataHash: bytea("calldata_hash").notNull(),
    /** Every unsigned call in signing order — one or two, depending on the observed allowance. */
    transactionsJson: jsonb("transactions_json").notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    invalidatedReason: text("invalidated_reason"),
  },
  (table) => [
    index("prepared_action_wallet_idx").on(table.walletId, table.createdAt),
    index("prepared_action_vault_idx").on(table.vaultId, table.createdAt),
    index("prepared_action_report_idx").on(table.reportId),
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
 * What the wallet did with a prepared action.
 *
 * Written only when a caller reports a hash. If the user signs and walks away, there is simply no
 * row — TR4CE does not poll for one, because polling would mean tracking transactions it never
 * agreed to be responsible for.
 */
export const transactionReceipt = pgTable(
  "transaction_receipt",
  {
    preparedActionId: text("prepared_action_id")
      .primaryKey()
      .references(() => preparedAction.id),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    transactionHash: bytea("transaction_hash").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    /** All four confirmation columns move together, enforced by a CHECK in the migration. */
    confirmedBlockNumber: numeric("confirmed_block_number", { precision: 78, scale: 0 }),
    confirmedBlockHash: bytea("confirmed_block_hash"),
    status: text("status"),
    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }),
    effectiveGasPrice: numeric("effective_gas_price", { precision: 78, scale: 0 }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("transaction_receipt_hash_key").on(table.chainId, table.transactionHash)],
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
