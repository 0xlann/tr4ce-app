import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bytea } from "./columns.js";

/**
 * Curated identity and capability metadata — ERD.md section 3.
 *
 * Nothing here is discovered at runtime. Every row is seeded from the event-period vault manifest
 * in @tr4ce/test-vaults, which records the outcome of the ten-step onboarding gate against live
 * chain state. A protocol API is allowed to suggest a vault; it is never allowed to populate one.
 */

export const network = pgTable("network", {
  chainId: bigint("chain_id", { mode: "number" }).primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  nativeSymbol: text("native_symbol").notNull(),
  /**
   * Operational finality setting. The promotion worker reads this rather than a constant: a chain
   * with a different reorg profile changes the row, not the code.
   */
  confirmationDepth: integer("confirmation_depth").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const protocol = pgTable("protocol", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  adapterKey: text("adapter_key").notNull(),
  documentationUrl: text("documentation_url"),
});

export const asset = pgTable(
  "asset",
  {
    id: uuid("id").primaryKey(),
    chainId: bigint("chain_id", { mode: "number" })
      .notNull()
      .references(() => network.chainId),
    address: bytea("address").notNull(),
    /** Untrusted display metadata. Identity rests on `canonical_key` and the curated address. */
    symbol: text("symbol"),
    name: text("name"),
    decimals: smallint("decimals").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    verifiedAtBlock: numeric("verified_at_block", { precision: 78, scale: 0 }),
    codeHash: bytea("code_hash"),
  },
  (table) => [uniqueIndex("asset_chain_address_key").on(table.chainId, table.address)],
);

export const vault = pgTable(
  "vault",
  {
    id: uuid("id").primaryKey(),
    chainId: bigint("chain_id", { mode: "number" })
      .notNull()
      .references(() => network.chainId),
    address: bytea("address").notNull(),
    protocolId: uuid("protocol_id")
      .notNull()
      .references(() => protocol.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => asset.id),
    shareDecimals: smallint("share_decimals").notNull(),
    name: text("name"),
    symbol: text("symbol"),
    /** Provenance only. The Substreams `initialBlock` follows the manifest window, not this. */
    deploymentBlock: numeric("deployment_block", { precision: 78, scale: 0 }),
    codeHash: bytea("code_hash").notNull(),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_chain_address_key").on(table.chainId, table.address),
    /**
     * Referenced by the composite foreign keys that keep an observation, and any report citing it,
     * on the same chain as its vault. See migrations/0001_registry_observations.sql.
     */
    uniqueIndex("vault_id_chain_key").on(table.id, table.chainId),
    index("vault_asset_idx").on(table.assetId),
  ],
);

/**
 * Append-only capability profiles.
 *
 * A profile is never mutated: an old report must keep resolving to the interpretation that was in
 * force when it was written. A changed implementation closes the open profile by setting
 * `effective_to_block` and opens a new one.
 */
export const vaultCapability = pgTable(
  "vault_capability",
  {
    id: uuid("id").primaryKey(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vault.id),
    adapterKey: text("adapter_key").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    implementationAddress: bytea("implementation_address"),
    implementationCodeHash: bytea("implementation_code_hash"),
    capabilities: jsonb("capabilities").notNull(),
    /** Inclusive. */
    effectiveFromBlock: numeric("effective_from_block", { precision: 78, scale: 0 }).notNull(),
    /** Exclusive; null while the profile is the open one. */
    effectiveToBlock: numeric("effective_to_block", { precision: 78, scale: 0 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("vault_capability_vault_from_idx").on(table.vaultId, table.effectiveFromBlock),
    /** Referenced by `vault_snapshot`'s composite FK, which pins a snapshot to its own vault. */
    uniqueIndex("vault_capability_id_vault_key").on(table.id, table.vaultId),
  ],
);

export const networkRelations = relations(network, ({ many }) => ({
  assets: many(asset),
  vaults: many(vault),
}));

export const vaultRelations = relations(vault, ({ one, many }) => ({
  network: one(network, { fields: [vault.chainId], references: [network.chainId] }),
  protocol: one(protocol, { fields: [vault.protocolId], references: [protocol.id] }),
  asset: one(asset, { fields: [vault.assetId], references: [asset.id] }),
  capabilities: many(vaultCapability),
}));

export const vaultCapabilityRelations = relations(vaultCapability, ({ one }) => ({
  vault: one(vault, { fields: [vaultCapability.vaultId], references: [vault.id] }),
}));
