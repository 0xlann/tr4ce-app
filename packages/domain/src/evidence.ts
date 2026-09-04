import { z } from "zod";

import { baseUnitStringSchema, basisPointsSchema, signedBaseUnitStringSchema } from "./amounts.js";
import { blockHashSchema, blockNumberStringSchema, chainIdSchema, vaultIdentitySchema } from "./identity.js";
import { policyEvaluationSchema } from "./policy.js";

export const provenanceEntrySchema = z.object({
  sourceType: z.enum(["indexed", "rpc", "simulation", "cached"]),
  chainId: chainIdSchema,
  blockNumber: blockNumberStringSchema,
  blockHash: blockHashSchema,
  reference: z.string().min(1),
});
export type ProvenanceEntry = z.infer<typeof provenanceEntrySchema>;

export const observedShareValueSchema = z.object({
  oneShareBaseUnits: baseUnitStringSchema,
  assetsNow: baseUnitStringSchema,
  assetsAtStart: baseUnitStringSchema,
  windowDays: z.number().int().positive(),
  returnBps: basisPointsSchema,
});
export type ObservedShareValue = z.infer<typeof observedShareValueSchema>;

export const evidenceObservationsSchema = z.object({
  shareValue: observedShareValueSchema,
  totalAssets: baseUnitStringSchema,
  netFlowAssets: signedBaseUnitStringSchema,
  maxWithdrawAssets: baseUnitStringSchema.nullable(),
});
export type EvidenceObservations = z.infer<typeof evidenceObservationsSchema>;

export const evidenceReportV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"),
  reportId: z.string().regex(/^trc_[A-Za-z0-9]+$/, "Expected a TR4CE report identifier"),
  calculationVersion: z.string().min(1),
  vault: vaultIdentitySchema,
  asOf: z.object({
    blockNumber: blockNumberStringSchema,
    blockHash: blockHashSchema,
    timestamp: z.string().datetime(),
  }),
  generatedAt: z.string().datetime(),
  observations: evidenceObservationsSchema,
  policy: policyEvaluationSchema,
  provenance: z.array(provenanceEntrySchema).min(1),
  limitations: z.array(z.string().min(1)).min(1),
});
export type EvidenceReportV1 = z.infer<typeof evidenceReportV1Schema>;

export const evidenceReportV1JsonSchema = z.toJSONSchema(evidenceReportV1Schema);
