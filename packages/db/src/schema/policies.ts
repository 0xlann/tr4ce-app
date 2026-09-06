import { relations } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bytea } from "./columns.js";

/**
 * User policy — ERD.md section 5.
 *
 * A policy is versioned rather than edited. A report cites the exact version it was judged against,
 * so mutating a policy in place would silently rewrite the meaning of every verdict already issued.
 */

export const wallet = pgTable("wallet", {
  id: uuid("id").primaryKey(),
  /** A display preference. Identity is the address alone — the same address is the same wallet. */
  chainScope: text("chain_scope"),
  address: bytea("address").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const policy = pgTable("policy", {
  id: uuid("id").primaryKey(),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => wallet.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Archiving hides a policy; it never removes one a report still cites. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const policyVersion = pgTable(
  "policy_version",
  {
    id: uuid("id").primaryKey(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policy.id),
    versionNumber: integer("version_number").notNull(),
    schemaVersion: text("schema_version").notNull(),
    /** The canonical artifact. `policyRule` below is a projection of this, never its source. */
    canonicalJson: jsonb("canonical_json").notNull(),
    contentHash: bytea("content_hash").notNull(),
    source: text("source").notNull(),
    /** NULL until a person accepts it. Nothing evaluates against an unconfirmed version. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("policy_version_number_key").on(table.policyId, table.versionNumber),
    uniqueIndex("policy_version_content_key").on(table.policyId, table.contentHash),
  ],
);

/**
 * Normalized rule rows for query and audit.
 *
 * Written in the same transaction as the version they project, and required by ERD section 5 to
 * match it. They exist so a rule can be queried without parsing JSON, not so it can be edited.
 */
export const policyRule = pgTable(
  "policy_rule",
  {
    id: uuid("id").primaryKey(),
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => policyVersion.id),
    ruleKey: text("rule_key").notNull(),
    operator: text("operator").notNull(),
    valueJson: jsonb("value_json").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    uniqueIndex("policy_rule_key_unique").on(table.policyVersionId, table.ruleKey),
    uniqueIndex("policy_rule_id_version_key").on(table.id, table.policyVersionId),
  ],
);

export const walletRelations = relations(wallet, ({ many }) => ({
  policies: many(policy),
}));

export const policyRelations = relations(policy, ({ one, many }) => ({
  wallet: one(wallet, { fields: [policy.walletId], references: [wallet.id] }),
  versions: many(policyVersion),
}));

export const policyVersionRelations = relations(policyVersion, ({ one, many }) => ({
  policy: one(policy, { fields: [policyVersion.policyId], references: [policy.id] }),
  rules: many(policyRule),
}));

export const policyRuleRelations = relations(policyRule, ({ one }) => ({
  version: one(policyVersion, {
    fields: [policyRule.policyVersionId],
    references: [policyVersion.id],
  }),
}));
