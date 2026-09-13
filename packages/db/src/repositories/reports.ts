import {
  persistedRuleStatus,
  reportStatusSchema,
  type ObservationPurpose,
  type PolicyEvaluation,
  type PolicyRuleKey,
  type ReportStatus,
} from "@tr4ce/domain";
import { and, eq } from "drizzle-orm";

import type { Executor } from "../client.js";
import { reportObservationId, ruleResultId } from "../ids.js";
import { hexToBytes } from "../schema/columns.js";
import { evidenceReport, reportObservation, ruleResult } from "../schema/reports.js";

/**
 * Writing and reading immutable evidence reports.
 *
 * A stored report is never recomputed. `resultJson` holds the exact validated response that was
 * served, so re-reading it later shows what a user was actually told rather than what today's
 * engine would say about the same blocks.
 *
 * Idempotency is the database's job, not this module's. `evidence_report.id` is derived from the
 * observations, and `evidence_report_input_key` is unique on
 * `(canonical_input_hash, calculation_version, schema_version)`. `insertReport` therefore inserts
 * optimistically and reads back on conflict — it never checks first, which would leave a window in
 * which two concurrent requests both saw "absent" and both tried to write.
 */

/** One row this report rests on, already resolved to the observation's primary key. */
export interface ReportCitation {
  observationType: "snapshot" | "flow" | "rpc_call";
  observationId: string;
  purpose: ObservationPurpose;
}

export interface InsertReportInput {
  reportId: string;
  canonicalInputHash: string;
  vaultId: string;
  chainId: number;
  /** Null only for an evidence-only report, which pairs with a `not_evaluated` status. */
  policyVersionId: string | null;
  asOf: { blockNumber: string; blockHash: string; timestamp: string };
  windowSeconds: number;
  /** Null when no start observation was available, so no spacing was ever measured. */
  actualElapsedSeconds: number | null;
  calculationVersion: string;
  schemaVersion: string;
  status: ReportStatus;
  /** The validated response, exactly as it will be served. */
  resultJson: unknown;
  citations: readonly ReportCitation[];
}

export interface StoredReport {
  reportId: string;
  resultJson: unknown;
  status: ReportStatus;
  canonical: boolean;
  createdAt: Date;
  /** False when an equivalent report already existed and this call wrote nothing. */
  created: boolean;
}

export class ReportCitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCitationError";
  }
}

/**
 * Store a report and its citations, or return the equivalent report already stored.
 *
 * The whole write is one transaction the caller owns: a report whose citations failed to land would
 * be a claim with nothing behind it, which is worse than no report at all.
 */
export async function insertReport(
  tx: Executor,
  input: InsertReportInput,
): Promise<StoredReport> {
  if (input.citations.length === 0) {
    // A report with no citations cannot be checked, and being checkable is the entire product.
    throw new ReportCitationError(`Report ${input.reportId} cites no observations.`);
  }

  const status = reportStatusSchema.parse(input.status);

  const inserted = await tx
    .insert(evidenceReport)
    .values({
      id: input.reportId,
      vaultId: input.vaultId,
      chainId: input.chainId,
      policyVersionId: input.policyVersionId,
      asOfBlockNumber: input.asOf.blockNumber,
      asOfBlockHash: hexToBytes(input.asOf.blockHash),
      asOfTime: new Date(input.asOf.timestamp),
      windowSeconds: input.windowSeconds,
      actualElapsedSeconds: input.actualElapsedSeconds,
      calculationVersion: input.calculationVersion,
      schemaVersion: input.schemaVersion,
      status,
      resultJson: input.resultJson,
      canonicalInputHash: hexToBytes(`0x${input.canonicalInputHash}`),
    })
    // Both unique keys matter: the primary key catches the same observations, and the input key
    // catches an equivalent report that somehow reached a different id.
    .onConflictDoNothing()
    .returning({ id: evidenceReport.id });

  if (inserted.length === 0) {
    const existing = await readReport(tx, input.reportId);

    if (existing === null) {
      // The id was free but the input key was taken: the same observations under a different
      // schema_version. Surfaced rather than swallowed, because silently returning some other
      // report would answer a question the caller did not ask.
      throw new ReportCitationError(
        `Report ${input.reportId} conflicts with an existing report over the same inputs at a different schema version.`,
      );
    }

    return { ...existing, created: false };
  }

  await tx.insert(reportObservation).values(
    input.citations.map((citation, ordinal) => ({
      id: reportObservationId(input.reportId, citation.observationId),
      reportId: input.reportId,
      vaultId: input.vaultId,
      observationType: citation.observationType,
      vaultFlowId: citation.observationType === "flow" ? citation.observationId : null,
      vaultSnapshotId: citation.observationType === "snapshot" ? citation.observationId : null,
      rpcObservationId: citation.observationType === "rpc_call" ? citation.observationId : null,
      purpose: citation.purpose,
      ordinal,
    })),
  );

  const stored = await readReport(tx, input.reportId);

  if (stored === null) {
    throw new ReportCitationError(`Report ${input.reportId} vanished immediately after insertion.`);
  }

  return { ...stored, created: true };
}

/**
 * Persist the per-rule verdicts beside the report.
 *
 * Separate from `insertReport` because an evidence-only report has none, and folding an empty array
 * into the report insert would make "no rules" and "rules that produced nothing" the same call.
 */
export async function insertRuleResults(
  tx: Executor,
  input: {
    reportId: string;
    policyVersionId: string;
    ruleIds: Readonly<Record<PolicyRuleKey, string>>;
    evaluation: PolicyEvaluation;
    /** Report observation ids backing each rule, keyed by rule. Empty is allowed. */
    evidenceRefs?: Readonly<Partial<Record<PolicyRuleKey, readonly string[]>>>;
    thresholds: Readonly<Record<PolicyRuleKey, unknown>>;
  },
): Promise<number> {
  const rows = input.evaluation.rules.map((rule) => ({
    id: ruleResultId(input.reportId, input.ruleIds[rule.key]),
    reportId: input.reportId,
    policyRuleId: input.ruleIds[rule.key],
    policyVersionId: input.policyVersionId,
    status: persistedRuleStatus(rule.status),
    // Null, never a stand-in: the CHECK in 0002 rejects a PASS that observed nothing, so a
    // fabricated value here would be caught rather than stored.
    observedJson: rule.observedValue === null ? null : { value: rule.observedValue },
    thresholdJson: { value: input.thresholds[rule.key] },
    reasonCodes: [...rule.reasonCodes],
    evidenceRefs: [...(input.evidenceRefs?.[rule.key] ?? [])],
  }));

  if (rows.length === 0) {
    return 0;
  }

  await tx.insert(ruleResult).values(rows).onConflictDoNothing();

  return rows.length;
}

/** Read one stored report. Returns what was served, not a recomputation of it. */
export async function readReport(tx: Executor, reportId: string): Promise<Omit<StoredReport, "created"> | null> {
  const rows = await tx
    .select({
      reportId: evidenceReport.id,
      resultJson: evidenceReport.resultJson,
      status: evidenceReport.status,
      canonical: evidenceReport.canonical,
      createdAt: evidenceReport.createdAt,
    })
    .from(evidenceReport)
    .where(eq(evidenceReport.id, reportId));

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  return {
    reportId: row.reportId,
    resultJson: row.resultJson,
    status: reportStatusSchema.parse(row.status),
    canonical: row.canonical,
    createdAt: row.createdAt,
  };
}

/** The report observations a stored report cites, in the order they were written. */
export async function listReportCitations(
  tx: Executor,
  reportId: string,
): Promise<{ id: string; observationType: string; purpose: string; ordinal: number }[]> {
  return tx
    .select({
      id: reportObservation.id,
      observationType: reportObservation.observationType,
      purpose: reportObservation.purpose,
      ordinal: reportObservation.ordinal,
    })
    .from(reportObservation)
    .where(eq(reportObservation.reportId, reportId))
    .orderBy(reportObservation.ordinal);
}

/** Whether a vault already has a canonical report at a given block. Used by the read routes. */
export async function findReportAtBlock(
  tx: Executor,
  vaultId: string,
  blockNumber: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: evidenceReport.id })
    .from(evidenceReport)
    .where(
      and(
        eq(evidenceReport.vaultId, vaultId),
        eq(evidenceReport.asOfBlockNumber, blockNumber),
        eq(evidenceReport.canonical, true),
      ),
    )
    .orderBy(evidenceReport.createdAt);

  return rows[0]?.id ?? null;
}
