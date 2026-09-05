import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bytea } from "./columns.js";
import { vault, vaultCapability } from "./registry.js";

/**
 * Confirmed application observations — ERD.md section 4.
 *
 * These are not the tables the sink writes. The built-in PostgreSQL Database Changes sink owns the
 * `raw_erc4626_*` tables and rewrites them freely while handling pre-confirmation reorgs; the
 * promotion worker copies only rows at or below the confirmed head into these, which is where
 * foreign keys, CHECK constraints and report references belong. Keeping the two apart is what lets
 * the sink undo a block without a report's foreign key standing in the way.
 */

export const vaultFlow = pgTable(
  "vault_flow",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    /** Denormalised for the composite foreign key that pins the row to its vault's chain. */
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    blockHash: bytea("block_hash").notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    transactionHash: bytea("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    kind: text("kind").notNull(),
    /** Only meaningful for `share_transfer`; null for deposits and withdrawals. */
    transferKind: text("transfer_kind"),
    sender: bytea("sender"),
    owner: bytea("owner"),
    receiver: bytea("receiver"),
    /** Null by event kind — a share transfer moves no assets. Never coerced to zero. */
    assets: numeric("assets", { precision: 78, scale: 0 }),
    shares: numeric("shares", { precision: 78, scale: 0 }).notNull(),
    /** Reorg state. A deep reorg flips this to false; rows are never deleted. */
    canonical: boolean("canonical").notNull().default(true),
    schemaVersion: text("schema_version").notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Canonical event identity. `kind` is part of the key because one log position is unique per
     * kind, and because deduplicating on transaction hash alone would collapse several vault
     * events emitted by the same transaction.
     */
    uniqueIndex("vault_flow_event_key").on(
      table.chainId,
      table.blockHash,
      table.transactionHash,
      table.logIndex,
      table.kind,
    ),
    index("vault_flow_vault_block_idx").on(table.vaultId, table.blockNumber),
    index("vault_flow_reorg_idx").on(table.chainId, table.blockNumber, table.canonical),
    /** Referenced by `report_observation`'s composite FK. */
    uniqueIndex("vault_flow_id_vault_key").on(table.id, table.vaultId),
  ],
);

export const vaultSnapshot = pgTable(
  "vault_snapshot",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    /**
     * The capability profile in force at this block. Resolved during promotion against the
     * profile's `[effective_from_block, effective_to_block)` range; a snapshot with no covering
     * profile aborts the batch rather than being stored with a null interpretation.
     */
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => vaultCapability.id),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    blockHash: bytea("block_hash").notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    /**
     * Every read result is nullable because a failed call has no value. Null means the call
     * produced nothing usable. It never means zero, and no layer may substitute one for the other.
     */
    totalAssets: numeric("total_assets", { precision: 78, scale: 0 }),
    totalSupply: numeric("total_supply", { precision: 78, scale: 0 }),
    oneShareUnits: numeric("one_share_units", { precision: 78, scale: 0 }).notNull(),
    oneShareAssets: numeric("one_share_assets", { precision: 78, scale: 0 }),
    callStatus: text("call_status").notNull(),
    /** Validated per-method failures. Raw staging holds the same JSON as text; cast on promotion. */
    callErrors: jsonb("call_errors").notNull().default([]),
    /** Which rule fired this observation, carried through for auditability. */
    triggerActivity: boolean("trigger_activity").notNull(),
    triggerCheckpoint: boolean("trigger_checkpoint").notNull(),
    triggerAnchor: boolean("trigger_anchor").notNull(),
    canonical: boolean("canonical").notNull().default(true),
    schemaVersion: text("schema_version").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("vault_snapshot_identity_key").on(table.vaultId, table.blockHash, table.schemaVersion),
    index("vault_snapshot_vault_block_idx").on(table.vaultId, table.blockNumber),
    index("vault_snapshot_reorg_idx").on(table.chainId, table.blockNumber, table.canonical),
    uniqueIndex("vault_snapshot_id_vault_key").on(table.id, table.vaultId),
  ],
);

/**
 * Minimal report identity — ERD.md section 6.
 *
 * Task 6 owns the full evidence report schema (rule results, rpc observations, policy links). Only
 * what a deep reorg has to reach is defined here, because "a detected deep reorg invalidates every
 * promoted dependent" is a Task 3 acceptance clause and cannot be proven against tables that do
 * not exist. Task 6 extends these columns; it does not replace them.
 */
export const evidenceReport = pgTable(
  "evidence_report",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    asOfBlockNumber: numeric("as_of_block_number", { precision: 78, scale: 0 }).notNull(),
    asOfBlockHash: bytea("as_of_block_hash").notNull(),
    schemaVersion: text("schema_version").notNull(),
    calculationVersion: text("calculation_version").notNull(),
    /**
     * Invalidation is state, not deletion (ERD section 11). A report whose evidence was orphaned
     * stays readable and stays cited; it simply stops being canonical.
     */
    canonical: boolean("canonical").notNull().default(true),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("evidence_report_vault_idx").on(table.vaultId, table.asOfBlockNumber),
    uniqueIndex("evidence_report_id_vault_key").on(table.id, table.vaultId),
  ],
);

/**
 * Which observations a report rests on.
 *
 * Exactly one of the two observation columns is set, enforced by a CHECK in the migration. The
 * composite foreign keys are the point of this table: they make it impossible for a report on one
 * vault to cite another vault's observation through an application bug.
 */
export const reportObservation = pgTable(
  "report_observation",
  {
    id: uuid("id").primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => evidenceReport.id),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    vaultFlowId: uuid("vault_flow_id").references(() => vaultFlow.id),
    vaultSnapshotId: uuid("vault_snapshot_id").references(() => vaultSnapshot.id),
    role: text("role").notNull(),
  },
  (table) => [
    uniqueIndex("report_observation_unique").on(
      table.reportId,
      table.vaultFlowId,
      table.vaultSnapshotId,
    ),
    index("report_observation_flow_idx").on(table.vaultFlowId),
    index("report_observation_snapshot_idx").on(table.vaultSnapshotId),
  ],
);

/**
 * Append-only reorg audit trail.
 *
 * One row per subject invalidated by one detected deep reorg. Nothing here is ever updated or
 * deleted: the record of what was believed, and when it stopped being true, is the artifact.
 */
export const reorgInvalidation = pgTable(
  "reorg_invalidation",
  {
    id: uuid("id").primaryKey(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    orphanedBlockHash: bytea("orphaned_block_hash").notNull(),
    canonicalBlockHash: bytea("canonical_block_hash").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("reorg_invalidation_subject_idx").on(table.subjectKind, table.subjectId),
    index("reorg_invalidation_block_idx").on(table.chainId, table.blockNumber),
  ],
);

export const vaultFlowRelations = relations(vaultFlow, ({ one }) => ({
  vault: one(vault, { fields: [vaultFlow.vaultId], references: [vault.id] }),
}));

export const vaultSnapshotRelations = relations(vaultSnapshot, ({ one }) => ({
  vault: one(vault, { fields: [vaultSnapshot.vaultId], references: [vault.id] }),
  capability: one(vaultCapability, {
    fields: [vaultSnapshot.capabilityId],
    references: [vaultCapability.id],
  }),
}));

export const evidenceReportRelations = relations(evidenceReport, ({ one, many }) => ({
  vault: one(vault, { fields: [evidenceReport.vaultId], references: [vault.id] }),
  observations: many(reportObservation),
}));

export const reportObservationRelations = relations(reportObservation, ({ one }) => ({
  report: one(evidenceReport, {
    fields: [reportObservation.reportId],
    references: [evidenceReport.id],
  }),
  flow: one(vaultFlow, { fields: [reportObservation.vaultFlowId], references: [vaultFlow.id] }),
  snapshot: one(vaultSnapshot, {
    fields: [reportObservation.vaultSnapshotId],
    references: [vaultSnapshot.id],
  }),
}));
