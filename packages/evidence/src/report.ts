import {
  evidenceReportV1Schema,
  provenanceEntrySchema,
  type BaseUnitString,
  type CapabilityProbe,
  type EvidenceReportV1,
  type PolicyEvaluation,
  type ProvenanceEntry,
  type ReasonCode,
  type VaultIdentity,
} from "@tr4ce/domain";

import { deriveReportId } from "./canonical.js";
import { isUsable } from "./capability.js";
import { aggregateFlows, type FlowAggregate, type FlowRow } from "./flows.js";
import { observeShareValue } from "./share-value.js";

/**
 * Assembling an evidence report, with no I/O of any kind.
 *
 * "Pure" here includes the clock and the random number generator: `generatedAt`,
 * `calculationVersion`, and every observation are inputs, and the report identifier is derived from
 * them. Reading the time inside this function would make the same evidence produce a different
 * report on every call, and the reproducibility guarantee (PRD TR-F-016) would be unverifiable.
 */

/** One promoted `vault_snapshot`, with amounts already parsed out of PostgreSQL's decimal strings. */
export interface SnapshotObservation {
  /**
   * Which vault this snapshot describes.
   *
   * Required so the engine can refuse a start and end taken from different vaults. Task 3 makes
   * that impossible in the database through composite foreign keys; nothing structural prevents it
   * one layer up, and the result would be a confident return computed across two vaults with
   * provenance citing both blocks as though they belonged together.
   */
  vaultId: string;
  blockNumber: string;
  blockHash: string;
  /** ISO-8601 UTC. */
  blockTime: string;
  totalAssets: bigint | null;
  totalSupply: bigint | null;
  /** Usually `10^shareDecimals`. The unit `oneShareAssets` is quoted in. */
  oneShareUnits: bigint;
  /** `convertToAssets(oneShareUnits)`. Null when the call produced nothing usable. */
  oneShareAssets: bigint | null;
  schemaVersion: string;
}

/** Account-scoped current reads. Deliberately separate: these are newer than the report block. */
export interface AccountLimitObservation {
  blockNumber: string;
  blockHash: string;
  maxWithdrawAssets: bigint | null;
  probes: readonly CapabilityProbe[];
}

export interface VaultCapabilityProfile {
  adapterKey: string;
  adapterVersion: string;
  probes: readonly CapabilityProbe[];
}

export interface EvidenceInput {
  vault: VaultIdentity;
  asOf: { blockNumber: string; blockHash: string; timestamp: string };
  /** Null when the requested window reaches further back than the indexed history. */
  start: SnapshotObservation | null;
  end: SnapshotObservation;
  flows: readonly FlowRow[];
  accountLimits: AccountLimitObservation | null;
  capability: VaultCapabilityProfile;
  /** The window the caller asked for. The actual elapsed time is measured, not assumed. */
  windowDays: number;
  calculationVersion: string;
  /** ISO-8601 UTC, supplied by the caller. Never read from the clock here. */
  generatedAt: string;
}

export interface DraftObservations {
  /** Null when no return could be computed. Never a stand-in value. */
  shareValue: {
    oneShareBaseUnits: BaseUnitString;
    assetsNow: BaseUnitString;
    assetsAtStart: BaseUnitString;
    windowDays: number;
    returnBps: number;
    numerator: bigint;
    denominator: bigint;
    rounding: "floor";
  } | null;
  totalAssets: BaseUnitString | null;
  netFlowAssets: string;
  maxWithdrawAssets: BaseUnitString | null;
}

export interface EvidenceReportDraft {
  schemaVersion: "1.0.0";
  reportId: string;
  calculationVersion: string;
  vault: VaultIdentity;
  asOf: { blockNumber: string; blockHash: string; timestamp: string };
  generatedAt: string;
  observations: DraftObservations;
  flows: FlowAggregate;
  /**
   * Seconds between the start and end observations as the chain recorded them.
   *
   * ARCHITECTURE.md section 4.2 requires the actual elapsed time be retained rather than inferred
   * from the requested window: the nearest available snapshot is rarely exactly N days back, and a
   * return quoted over an assumed period is a different number from the one that was measured.
   */
  elapsedSeconds: number | null;
  /** Everything the report could not establish. Empty means every value is present. */
  reasonCodes: ReasonCode[];
  provenance: ProvenanceEntry[];
  limitations: string[];
}

const BACKWARD_LOOKING_LIMITATION =
  "Observed share-value return is backward-looking and is not a forecast.";

/** A draft carrying every value the V1 response contract requires. */
export type CompleteEvidenceReportDraft = EvidenceReportDraft & {
  observations: DraftObservations & {
    shareValue: NonNullable<DraftObservations["shareValue"]>;
    totalAssets: NonNullable<DraftObservations["totalAssets"]>;
  };
};

/**
 * True when every value the V1 response contract requires is present.
 *
 * A type guard rather than a boolean so `attachPolicy` needs no non-null assertion: an assertion
 * would keep compiling if this predicate later stopped checking one of the fields.
 */
export function isComplete(draft: EvidenceReportDraft): draft is CompleteEvidenceReportDraft {
  return draft.observations.shareValue !== null && draft.observations.totalAssets !== null;
}

/**
 * Build the report body from observations.
 *
 * Returns a draft rather than an `EvidenceReportV1` because the V1 contract requires a `policy`
 * block, and policy is evaluated *against* evidence — accepting an evaluation here would invert
 * that dependency inside the signature. `attachPolicy` closes the report once Task 5's evaluator
 * has run.
 */
export function buildEvidence(input: EvidenceInput): EvidenceReportDraft {
  const reasonCodes: ReasonCode[] = [];

  const flows = aggregateFlows(input.flows);
  const compatibility = checkCompatibility(input);

  reasonCodes.push(...compatibility);

  const shareValue = compatibility.length > 0 ? null : buildShareValue(input, reasonCodes);
  const totalAssets = readTotalAssets(input, reasonCodes);
  const maxWithdrawAssets = readMaxWithdraw(input, reasonCodes);

  const elapsedSeconds = measureElapsed(input);
  const provenance = buildProvenance(input);
  const limitations = buildLimitations(input, reasonCodes, flows, elapsedSeconds);

  const observations: DraftObservations = {
    shareValue,
    totalAssets,
    netFlowAssets: flows.netFlowAssets.toString(),
    maxWithdrawAssets,
  };

  /*
   * The identifier covers the inputs, not the output: two reports built from the same observations
   * at the same calculation version are the same report, and changing any observed value must
   * produce a different id rather than silently overwrite a published one.
   */
  const reportId = deriveReportId({
    vault: input.vault,
    asOf: input.asOf,
    start: serialiseSnapshot(input.start),
    end: serialiseSnapshot(input.end),
    flows: input.flows.map((row) => ({
      kind: row.kind,
      transferKind: row.transferKind,
      assets: row.assets,
      shares: row.shares,
      canonical: row.canonical,
    })),
    accountLimits:
      input.accountLimits === null
        ? null
        : {
            blockNumber: input.accountLimits.blockNumber,
            blockHash: input.accountLimits.blockHash,
            maxWithdrawAssets: input.accountLimits.maxWithdrawAssets,
          },
    capability: { adapterKey: input.capability.adapterKey, adapterVersion: input.capability.adapterVersion },
    windowDays: input.windowDays,
    calculationVersion: input.calculationVersion,
    generatedAt: input.generatedAt,
  });

  return {
    schemaVersion: "1.0.0",
    reportId,
    calculationVersion: input.calculationVersion,
    vault: input.vault,
    asOf: input.asOf,
    generatedAt: input.generatedAt,
    observations,
    flows,
    elapsedSeconds,
    reasonCodes,
    provenance,
    limitations,
  };
}

/**
 * Close a draft into a publishable report.
 *
 * Throws on an incomplete draft rather than filling the gap: the V1 response contract has no way to
 * say "no share value", so emitting one anyway would require inventing a number. An incomplete
 * draft is surfaced to the caller as a draft plus its reason codes.
 */
export function attachPolicy(
  draft: EvidenceReportDraft,
  policy: PolicyEvaluation,
): EvidenceReportV1 {
  if (!isComplete(draft)) {
    throw new Error(
      `Report ${draft.reportId} is incomplete (${draft.reasonCodes.join(", ") || "no share value"}); the V1 contract cannot represent a missing observation.`,
    );
  }

  const shareValue = draft.observations.shareValue;

  // Parsed, not cast: the schema is the contract, and a drift between this assembly and the
  // published shape must fail here rather than at an API boundary.
  return evidenceReportV1Schema.parse({
    schemaVersion: draft.schemaVersion,
    reportId: draft.reportId,
    calculationVersion: draft.calculationVersion,
    vault: draft.vault,
    asOf: draft.asOf,
    generatedAt: draft.generatedAt,
    observations: {
      shareValue: {
        oneShareBaseUnits: shareValue.oneShareBaseUnits,
        assetsNow: shareValue.assetsNow,
        assetsAtStart: shareValue.assetsAtStart,
        windowDays: shareValue.windowDays,
        returnBps: shareValue.returnBps,
      },
      totalAssets: draft.observations.totalAssets,
      netFlowAssets: draft.observations.netFlowAssets,
      maxWithdrawAssets: draft.observations.maxWithdrawAssets,
    },
    policy,
    provenance: draft.provenance,
    limitations: draft.limitations,
  });
}

/**
 * Reject a start and end that do not describe the same thing.
 *
 * A return computed across a decimals change or an implementation swap is arithmetic performed on
 * two different quantities. PRD TR-F-012 requires both observations refer to compatible vault
 * implementations and canonical assets.
 */
function checkCompatibility(input: EvidenceInput): ReasonCode[] {
  const reasons: ReasonCode[] = [];

  if (input.start === null) {
    return reasons;
  }

  /*
   * A cross-vault pairing throws rather than returning a reason code. UNKNOWN is a normal outcome
   * that gets rendered and moved past; this is a caller assembling nonsense, and letting it come
   * back as ordinary missing evidence would hide a bug as a data condition.
   */
  if (input.start.vaultId !== input.end.vaultId) {
    throw new Error(
      `Start snapshot belongs to vault ${input.start.vaultId} but end belongs to ${input.end.vaultId}; refusing to compute a return across two vaults.`,
    );
  }

  if (input.start.oneShareUnits !== input.end.oneShareUnits) {
    reasons.push("INCOMPATIBLE_IMPLEMENTATION");
  }

  if (input.start.schemaVersion !== input.end.schemaVersion) {
    /*
     * A producer schema change may quote the same field differently, so the two figures are not
     * safely comparable. Reported as INCOMPATIBLE_IMPLEMENTATION, not INCOMPATIBLE_ASSET: the
     * asset did not change, and saying it did would tell a reader the vault swapped its underlying
     * token.
     */
    reasons.push("INCOMPATIBLE_IMPLEMENTATION");
  }

  return reasons;
}

function buildShareValue(
  input: EvidenceInput,
  reasonCodes: ReasonCode[],
): DraftObservations["shareValue"] {
  const result = observeShareValue(input.start?.oneShareAssets ?? null, input.end.oneShareAssets);

  if (!result.ok) {
    reasonCodes.push(result.failure.reasonCode);
    return null;
  }

  return {
    oneShareBaseUnits: input.end.oneShareUnits.toString() as BaseUnitString,
    assetsNow: input.end.oneShareAssets!.toString() as BaseUnitString,
    assetsAtStart: input.start!.oneShareAssets!.toString() as BaseUnitString,
    windowDays: input.windowDays,
    returnBps: result.return.value,
    numerator: result.return.numerator,
    denominator: result.return.denominator,
    rounding: result.return.rounding,
  };
}

function readTotalAssets(input: EvidenceInput, reasonCodes: ReasonCode[]): BaseUnitString | null {
  if (input.end.totalAssets === null) {
    reasonCodes.push("CALL_REVERTED");
    return null;
  }

  return input.end.totalAssets.toString() as BaseUnitString;
}

/**
 * Account-scoped withdrawable assets, or null.
 *
 * Null whenever the capability profile says the answer cannot be trusted — a revert, or the
 * documented non-standard zero. Reporting that zero as a real figure would assert the account
 * cannot withdraw anything, which the contract never said.
 */
function readMaxWithdraw(input: EvidenceInput, reasonCodes: ReasonCode[]): BaseUnitString | null {
  if (input.accountLimits === null) {
    return null;
  }

  if (!isUsable(input.accountLimits.probes, "maxWithdraw")) {
    reasonCodes.push("AMBIGUOUS_CAPABILITY");
    return null;
  }

  if (input.accountLimits.maxWithdrawAssets === null) {
    reasonCodes.push("CALL_REVERTED");
    return null;
  }

  return input.accountLimits.maxWithdrawAssets.toString() as BaseUnitString;
}

/** Every claim traces back to a block. Indexed observations and current reads are labelled apart. */
function buildProvenance(input: EvidenceInput): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = [
    provenanceEntrySchema.parse({
      sourceType: "indexed",
      chainId: input.vault.chainId,
      blockNumber: input.end.blockNumber,
      blockHash: input.end.blockHash,
      reference: "vault_snapshot.end",
    }),
  ];

  if (input.start !== null) {
    entries.push(
      provenanceEntrySchema.parse({
        sourceType: "indexed",
        chainId: input.vault.chainId,
        blockNumber: input.start.blockNumber,
        blockHash: input.start.blockHash,
        reference: "vault_snapshot.start",
      }),
    );
  }

  if (input.accountLimits !== null) {
    entries.push(
      provenanceEntrySchema.parse({
        sourceType: "rpc",
        chainId: input.vault.chainId,
        blockNumber: input.accountLimits.blockNumber,
        blockHash: input.accountLimits.blockHash,
        reference: "account_limits.maxWithdraw",
      }),
    );
  }

  return entries;
}

/**
 * What a reader must know to interpret the numbers.
 *
 * The backward-looking caveat is unconditional (PRD section 3). The rest are added only when they
 * apply, so the list stays worth reading instead of becoming boilerplate nobody scans.
 */
function buildLimitations(
  input: EvidenceInput,
  reasonCodes: readonly ReasonCode[],
  flows: FlowAggregate,
  elapsed: number | null,
): string[] {
  const limitations = [BACKWARD_LOOKING_LIMITATION];

  if (elapsed !== null) {
    const actualDays = elapsed / 86_400;

    // Quoting a 7-day return measured over 6.2 days without saying so misstates the period.
    if (Math.abs(actualDays - input.windowDays) >= 0.5) {
      limitations.push(
        `Requested window is ${input.windowDays} days; the observations are ${actualDays.toFixed(2)} days apart.`,
      );
    }
  }

  if (reasonCodes.includes("MISSING_OBSERVATION")) {
    limitations.push("No start observation covers the requested window; return is unavailable.");
  }

  if (reasonCodes.includes("AMBIGUOUS_CAPABILITY")) {
    limitations.push(
      "A capability returned a value that cannot be interpreted; the affected figure is reported as unavailable rather than as zero.",
    );
  }

  if (reasonCodes.includes("CALL_REVERTED")) {
    limitations.push("A contract read reverted; the affected figure is unavailable.");
  }

  if (
    reasonCodes.includes("INCOMPATIBLE_IMPLEMENTATION") ||
    reasonCodes.includes("INCOMPATIBLE_ASSET")
  ) {
    limitations.push(
      "Start and end observations are not comparable; no return is computed across the change.",
    );
  }

  if (flows.excluded.mints > 0 || flows.excluded.burns > 0) {
    limitations.push(
      `Net flow excludes ${flows.excluded.mints} share mint(s) and ${flows.excluded.burns} burn(s), which are the share side of deposits and withdrawals already counted.`,
    );
  }

  if (flows.excluded.missingAssets > 0) {
    limitations.push(
      `Net flow omits ${flows.excluded.missingAssets} event(s) whose asset amount was unavailable; it is a lower bound.`,
    );
  }

  return limitations;
}

/** Chain-recorded seconds between the two observations, or null without a start. */
function measureElapsed(input: EvidenceInput): number | null {
  if (input.start === null) {
    return null;
  }

  const start = Date.parse(input.start.blockTime);
  const end = Date.parse(input.end.blockTime);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }

  return Math.round((end - start) / 1000);
}

function serialiseSnapshot(snapshot: SnapshotObservation | null): unknown {
  return snapshot === null
    ? null
    : {
        vaultId: snapshot.vaultId,
        blockNumber: snapshot.blockNumber,
        blockHash: snapshot.blockHash,
        blockTime: snapshot.blockTime,
        totalAssets: snapshot.totalAssets,
        totalSupply: snapshot.totalSupply,
        oneShareUnits: snapshot.oneShareUnits,
        oneShareAssets: snapshot.oneShareAssets,
        schemaVersion: snapshot.schemaVersion,
      };
}
