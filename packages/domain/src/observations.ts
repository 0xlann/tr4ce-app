import { z } from "zod";

import { baseUnitStringSchema } from "./amounts.js";
import { addressSchema, blockHashSchema, blockNumberStringSchema, chainIdSchema } from "./identity.js";

/**
 * Enum-like values shared by the Substreams producer, the raw staging tables, and the constrained
 * application schema.
 *
 * ERD section 11 requires every enum-like text column to carry a database CHECK constraint
 * "generated from shared schema values". These `.options` arrays are those values: a unit test in
 * @tr4ce/db asserts each CHECK list in migrations/0001_registry_observations.sql matches the
 * corresponding enum exactly, so adding a variant here without widening the constraint fails the
 * build rather than the insert.
 */

/** Onboarding state of a curated vault. */
export const vaultStatusSchema = z.enum(["candidate", "listed", "degraded", "unsupported"]);
export type VaultStatus = z.infer<typeof vaultStatusSchema>;

/** Economic event kinds recorded in `vault_flow`. */
export const flowKindSchema = z.enum(["deposit", "withdraw", "share_transfer"]);
export type FlowKind = z.infer<typeof flowKindSchema>;

/**
 * Share movement classification.
 *
 * Mints and burns are recorded rather than dropped so the evidence engine can prove it excluded
 * them from economic flow instead of never having seen them. `unspecified` is the producer's
 * fallback for an unrecognised discriminant and must stay representable.
 */
export const transferKindSchema = z.enum(["transfer", "mint", "burn", "unspecified"]);
export type TransferKind = z.infer<typeof transferKindSchema>;

/**
 * Outcome of the batched block-scoped reads behind one snapshot.
 *
 * A non-`ok` snapshot is still promoted: ARCHITECTURE.md section 9 makes a reverted read persist
 * its classification so the dependent rule becomes UNKNOWN. Dropping these rows would make missing
 * evidence invisible instead of explicit.
 */
export const callStatusSchema = z.enum(["ok", "partial", "reverted", "unspecified"]);
export type CallStatus = z.infer<typeof callStatusSchema>;

/** One per-method failure inside `vault_snapshot.call_errors`. */
export const callErrorSchema = z.object({
  method: z.string().min(1),
  classification: z.string().min(1),
});
export type CallError = z.infer<typeof callErrorSchema>;

export const callErrorsSchema = z.array(callErrorSchema);

/** Subjects that a detected deep reorg can invalidate. */
export const invalidationSubjectKindSchema = z.enum([
  "vault_flow",
  "vault_snapshot",
  "evidence_report",
]);
export type InvalidationSubjectKind = z.infer<typeof invalidationSubjectKindSchema>;

/**
 * Canonical identity of one observed event.
 *
 * Never deduplicate on transaction hash alone: one transaction can emit several vault events, and
 * the same transaction can appear in two competing blocks during a reorg.
 */
export const eventIdentitySchema = z.object({
  chainId: chainIdSchema,
  blockHash: blockHashSchema,
  transactionHash: blockHashSchema,
  logIndex: z.number().int().nonnegative(),
});
export type EventIdentity = z.infer<typeof eventIdentitySchema>;

/** A promoted `vault_flow` row, as the application sees it. */
export const vaultFlowSchema = z.object({
  chainId: chainIdSchema,
  vaultAddress: addressSchema,
  blockNumber: blockNumberStringSchema,
  blockHash: blockHashSchema,
  blockTime: z.string().datetime(),
  transactionHash: blockHashSchema,
  logIndex: z.number().int().nonnegative(),
  kind: flowKindSchema,
  transferKind: transferKindSchema.nullable(),
  sender: addressSchema.nullable(),
  owner: addressSchema.nullable(),
  receiver: addressSchema.nullable(),
  assets: baseUnitStringSchema.nullable(),
  shares: baseUnitStringSchema,
  canonical: z.boolean(),
  schemaVersion: z.string().min(1),
});
export type VaultFlow = z.infer<typeof vaultFlowSchema>;

/**
 * A promoted `vault_snapshot` row.
 *
 * Every amount is nullable because a failed read has no value. `null` means the call produced no
 * usable result; it never means zero, and no layer may substitute one for the other.
 */
export const vaultSnapshotSchema = z.object({
  chainId: chainIdSchema,
  vaultAddress: addressSchema,
  blockNumber: blockNumberStringSchema,
  blockHash: blockHashSchema,
  blockTime: z.string().datetime(),
  totalAssets: baseUnitStringSchema.nullable(),
  totalSupply: baseUnitStringSchema.nullable(),
  oneShareUnits: baseUnitStringSchema,
  oneShareAssets: baseUnitStringSchema.nullable(),
  callStatus: callStatusSchema,
  callErrors: callErrorsSchema,
  canonical: z.boolean(),
  schemaVersion: z.string().min(1),
});
export type VaultSnapshot = z.infer<typeof vaultSnapshotSchema>;

/**
 * The application promotion cursor.
 *
 * Distinct from the built-in sink's own `cursors` table: that one tracks what the sink has written
 * into raw staging, this one tracks what the worker has promoted into the constrained tables.
 */
export const indexerCursorSchema = z.object({
  chainId: chainIdSchema,
  streamKey: z.string().min(1),
  blockNumber: blockNumberStringSchema,
  blockHash: blockHashSchema,
  schemaVersion: z.string().min(1),
  updatedAt: z.string().datetime(),
});
export type IndexerCursor = z.infer<typeof indexerCursorSchema>;
