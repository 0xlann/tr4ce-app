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
import { vaultFlow, vaultSnapshot } from "./observations.js";
import { policyRule, policyVersion } from "./policies.js";
import { vault } from "./registry.js";

/**
 * Derived evidence — ERD.md section 6.
 *
 * A report is written once and never recomputed. `resultJson` holds the exact validated response
 * that was served, so re-reading a report months later shows what the user was actually told, not
 * what today's engine would say about the same blocks.
 */

export const evidenceReport = pgTable(
  "evidence_report",
  {
    /**
     * `trc_` plus the first 32 hex of `canonicalInputHash`.
     *
     * Text rather than a generated sortable id (ERD section 6) so that the same observations name
     * the same report by construction — the API's idempotency does not depend on remembering to
     * look the hash up first. Ordering comes from `createdAt` and `asOfBlockNumber`.
     */
    id: text("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    /** Denormalised for the composite foreign key that pins citations to this report's vault. */
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    /** NULL for an evidence-only report: evidence stands without a policy asked of it. */
    policyVersionId: uuid("policy_version_id").references(() => policyVersion.id),
    asOfBlockNumber: numeric("as_of_block_number", { precision: 78, scale: 0 }).notNull(),
    asOfBlockHash: bytea("as_of_block_hash").notNull(),
    asOfTime: timestamp("as_of_time", { withTimezone: true }).notNull(),
    /** The window requested. Kept apart from what was actually observed. */
    windowSeconds: bigint("window_seconds", { mode: "number" }).notNull(),
    /** The spacing the chain actually recorded. NULL when no start observation was available. */
    actualElapsedSeconds: bigint("actual_elapsed_seconds", { mode: "number" }),
    calculationVersion: text("calculation_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    status: text("status").notNull(),
    resultJson: jsonb("result_json").notNull(),
    canonicalInputHash: bytea("canonical_input_hash").notNull(),
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
    index("evidence_report_created_idx").on(table.createdAt),
    uniqueIndex("evidence_report_id_vault_key").on(table.id, table.vaultId),
    // ERD section 6: prevents duplicate equivalent reports. This is what the API's idempotency is
    // enforced by — not by a lookup the application performs before inserting.
    uniqueIndex("evidence_report_input_key").on(
      table.canonicalInputHash,
      table.calculationVersion,
      table.schemaVersion,
    ),
  ],
);

/**
 * Current and account-scoped call evidence — ERD.md section 6.
 *
 * The chain's answer is stored beside the interpretation of it, never in place of it. A reverted
 * call keeps its revert payload and gets no substituted value.
 */
export const rpcObservation = pgTable(
  "rpc_observation",
  {
    id: uuid("id").primaryKey(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    contractAddress: bytea("contract_address").notNull(),
    methodSelector: bytea("method_selector").notNull(),
    argsHash: bytea("args_hash").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    blockHash: bytea("block_hash").notNull(),
    /** NULL when the call produced nothing. Never a substituted zero. */
    rawResult: bytea("raw_result"),
    revertData: bytea("revert_data"),
    callStatus: text("call_status").notNull(),
    decodedJson: jsonb("decoded_json"),
    /** Names the provider. Never a credential — ERD section 6 states this outright. */
    providerKey: text("provider_key").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rpc_observation_contract_idx").on(
      table.chainId,
      table.contractAddress,
      table.blockNumber,
    ),
  ],
);

/**
 * Which observations a report rests on — ERD.md section 6.
 *
 * Exactly one observation column is set, and `observationType` must agree with which one, both
 * enforced by CHECKs in the migration. The composite foreign keys are the point of this table:
 * they make it impossible for a report on one vault to cite another vault's observation through an
 * application bug.
 */
export const reportObservation = pgTable(
  "report_observation",
  {
    id: uuid("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => evidenceReport.id),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    observationType: text("observation_type").notNull(),
    vaultFlowId: uuid("vault_flow_id").references(() => vaultFlow.id),
    vaultSnapshotId: uuid("vault_snapshot_id").references(() => vaultSnapshot.id),
    rpcObservationId: uuid("rpc_observation_id").references(() => rpcObservation.id),
    /** Which part of the claim this citation supports: the window start, the end, and so on. */
    purpose: text("purpose").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    uniqueIndex("report_observation_unique").on(
      table.reportId,
      table.vaultFlowId,
      table.vaultSnapshotId,
      table.rpcObservationId,
    ),
    index("report_observation_report_idx").on(table.reportId, table.ordinal),
    index("report_observation_flow_idx").on(table.vaultFlowId),
    index("report_observation_snapshot_idx").on(table.vaultSnapshotId),
    index("report_observation_rpc_idx").on(table.rpcObservationId),
  ],
);

/**
 * One rule's verdict, stored beside the threshold it was measured against — ERD.md section 6.
 *
 * Both sides are kept so the verdict can be re-derived from the row without re-reading the chain.
 */
export const ruleResult = pgTable(
  "rule_result",
  {
    id: uuid("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => evidenceReport.id),
    policyRuleId: uuid("policy_rule_id")
      .notNull()
      .references(() => policyRule.id),
    /** Denormalised so a composite key can pin the rule to the version the report was judged on. */
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => policyVersion.id),
    status: text("status").notNull(),
    /** NULL when the rule observed nothing at all. A PASS with no observation is rejected. */
    observedJson: jsonb("observed_json"),
    thresholdJson: jsonb("threshold_json").notNull(),
    reasonCodes: text("reason_codes").array().notNull().default([]),
    evidenceRefs: uuid("evidence_refs").array().notNull().default([]),
  },
  (table) => [
    uniqueIndex("rule_result_report_rule_key").on(table.reportId, table.policyRuleId),
    index("rule_result_report_idx").on(table.reportId),
  ],
);

export const evidenceReportRelations = relations(evidenceReport, ({ one, many }) => ({
  vault: one(vault, { fields: [evidenceReport.vaultId], references: [vault.id] }),
  policyVersion: one(policyVersion, {
    fields: [evidenceReport.policyVersionId],
    references: [policyVersion.id],
  }),
  observations: many(reportObservation),
  ruleResults: many(ruleResult),
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
  rpcCall: one(rpcObservation, {
    fields: [reportObservation.rpcObservationId],
    references: [rpcObservation.id],
  }),
}));

export const ruleResultRelations = relations(ruleResult, ({ one }) => ({
  report: one(evidenceReport, { fields: [ruleResult.reportId], references: [evidenceReport.id] }),
  rule: one(policyRule, { fields: [ruleResult.policyRuleId], references: [policyRule.id] }),
}));
