import {
  policyEvaluationSchema,
  type PolicyEvaluation,
  type PolicyRuleResult,
  type PolicyRuleStatus,
  type PolicyV1,
  type ReasonCode,
} from "@tr4ce/domain";
import type { EvidenceReportDraft } from "@tr4ce/evidence";

/**
 * Deterministic policy evaluation.
 *
 * Every rule answers with `PASS`, `FAIL`, or `UNKNOWN`, and the difference between the last two is
 * the point of the whole product. `FAIL` says the vault does not meet the rule. `UNKNOWN` says we
 * could not tell — a read reverted, an observation is missing, a capability is ambiguous. Collapsing
 * one into the other is the failure mode TR4CE exists to avoid: a fabricated `FAIL` slanders a fine
 * vault, and a fabricated `PASS` is worse.
 *
 * Nothing here reads a chain, a clock, or a database. It takes the evidence draft plus the few facts
 * that draft cannot carry, and returns a decision.
 */

const SECONDS_PER_DAY = 86_400;

/**
 * What the chain reported as the vault's underlying asset, already matched against the registry.
 *
 * `null` for the whole observation means `asset()` produced nothing. A present observation whose
 * `canonicalKey` is `null` means the call answered with an address the registry does not recognise.
 */
export interface AssetIdentityObservation {
  /** Registry canonical key for the returned address, or null when it matched no curated asset. */
  canonicalKey: string | null;
}

export interface EvaluationInput {
  policy: PolicyV1;
  draft: EvidenceReportDraft;
  /** Null when `asset()` gave no usable answer. */
  assetIdentity: AssetIdentityObservation | null;
  /**
   * ISO-8601 timestamp of the vault's deployment block, resolved by the caller.
   *
   * Required to tell "this vault is younger than the window" (FAIL) from "our index does not reach
   * back that far" (UNKNOWN). The manifest stores only a deployment block number, and this package
   * is pure, so the block cannot be resolved to a time here. Without it the history rule collapses
   * into UNKNOWN whenever coverage is short, and the distinction disappears.
   */
  vaultDeployedAt: string | null;
  /**
   * The owner the account-scoped reads in the draft were taken for.
   *
   * Compared against the policy's own owner. Without this check, evidence gathered for one wallet
   * could satisfy a withdrawal rule written for another.
   */
  observedOwner: string | null;
}

/**
 * Evaluate all five rules and fold them into one status.
 *
 * Truth table (ARCHITECTURE section 6): any `FAIL` wins; otherwise any `UNKNOWN` wins; only an
 * unbroken sweep of `PASS` passes. Every one of the five rules is required — `policyV1Schema` makes
 * all five fields mandatory — so "any required UNKNOWN" is simply "any UNKNOWN".
 */
export function evaluatePolicy(input: EvaluationInput): PolicyEvaluation {
  const rules: PolicyRuleResult[] = [
    evaluateUnderlyingAsset(input),
    evaluateMinimumHistory(input),
    evaluateMinimumTvl(input),
    evaluateMinimumObservedReturn(input),
    evaluateMinimumWithdrawable(input),
  ];

  // Parsed rather than returned directly: the evaluation is the artifact a report publishes, and a
  // drift between what is assembled here and the published contract must fail here.
  return policyEvaluationSchema.parse({
    version: 1,
    status: overallStatus(rules),
    rules,
  });
}

/** Any FAIL beats everything; any UNKNOWN beats a PASS. */
export function overallStatus(rules: readonly PolicyRuleResult[]): PolicyRuleStatus {
  if (rules.some((rule) => rule.status === "FAIL")) {
    return "FAIL";
  }

  if (rules.some((rule) => rule.status === "UNKNOWN")) {
    return "UNKNOWN";
  }

  return "PASS";
}

/**
 * Underlying asset.
 *
 * An address the registry does not recognise is `UNKNOWN`, not `FAIL`. We can only say a vault's
 * asset is outside the allowlist once we know what the asset is; an unrecognised address means
 * identity was never established, which PRD section 8.3 lists under "asset identity cannot be
 * verified".
 */
function evaluateUnderlyingAsset(input: EvaluationInput): PolicyRuleResult {
  const threshold = input.policy.underlyingAssets.join(", ");
  const references = ["vault.asset"];

  if (input.assetIdentity === null) {
    return unknown("underlyingAsset", threshold, null, references, ["CALL_REVERTED"]);
  }

  const observed = input.assetIdentity.canonicalKey;

  if (observed === null) {
    return unknown("underlyingAsset", threshold, null, references, ["INCOMPATIBLE_ASSET"]);
  }

  if (!input.policy.underlyingAssets.includes(observed as "USDC")) {
    return fail("underlyingAsset", threshold, observed, references, ["INCOMPATIBLE_ASSET"]);
  }

  return pass("underlyingAsset", threshold, observed, references);
}

/**
 * Minimum history.
 *
 * The split that matters: a vault younger than the window genuinely fails, while a vault old enough
 * whose history we simply have not indexed is unknown. Both look identical from the evidence draft
 * alone, which is why the deployment time is a separate input.
 */
function evaluateMinimumHistory(input: EvaluationInput): PolicyRuleResult {
  const requiredSeconds = input.policy.minHistoryDays * SECONDS_PER_DAY;
  const threshold = `${input.policy.minHistoryDays} days`;
  const references = ["vault_snapshot.start", "vault_snapshot.end"];
  const covered = input.draft.elapsedSeconds;
  const observed = covered === null ? null : `${(covered / SECONDS_PER_DAY).toFixed(2)} days`;

  if (covered !== null && covered >= requiredSeconds) {
    return pass("minimumHistory", threshold, observed, references);
  }

  const vaultAgeSeconds = ageSeconds(input);

  if (vaultAgeSeconds !== null && vaultAgeSeconds < requiredSeconds) {
    // The vault itself cannot have this much history. No amount of further indexing would change it.
    return fail(
      "minimumHistory",
      threshold,
      `${(vaultAgeSeconds / SECONDS_PER_DAY).toFixed(2)} days since deployment`,
      [...references, "vault.deploymentBlock"],
      [],
    );
  }

  // The vault may well be old enough; our observations are what fall short.
  return unknown("minimumHistory", threshold, observed, references, ["MISSING_OBSERVATION"]);
}

function evaluateMinimumTvl(input: EvaluationInput): PolicyRuleResult {
  const threshold = input.policy.minTvlAssets;
  const references = ["vault_snapshot.end"];
  const observed = input.draft.observations.totalAssets;

  if (observed === null) {
    return unknown("minimumTvl", threshold, null, references, reasonsFor(input.draft, "CALL_REVERTED"));
  }

  return BigInt(observed) >= BigInt(threshold)
    ? pass("minimumTvl", threshold, observed, references)
    : fail("minimumTvl", threshold, observed, references, []);
}

/**
 * Minimum observed return.
 *
 * A return measured over a different window than the policy asked about answers a different
 * question, so a window mismatch is `UNKNOWN` rather than a comparison against the wrong number.
 */
function evaluateMinimumObservedReturn(input: EvaluationInput): PolicyRuleResult {
  const rule = input.policy.minObservedReturnBps;
  const threshold = `${rule.value} bps over ${rule.windowDays} days`;
  const references = ["vault_snapshot.start", "vault_snapshot.end"];
  const shareValue = input.draft.observations.shareValue;

  if (shareValue === null) {
    return unknown(
      "minimumObservedReturn",
      threshold,
      null,
      references,
      reasonsFor(input.draft, "MISSING_OBSERVATION", "AMBIGUOUS_CAPABILITY", "INCOMPATIBLE_IMPLEMENTATION", "INCOMPATIBLE_ASSET"),
    );
  }

  if (shareValue.windowDays !== rule.windowDays) {
    return unknown(
      "minimumObservedReturn",
      threshold,
      `${shareValue.returnBps} bps over ${shareValue.windowDays} days`,
      references,
      ["MISSING_OBSERVATION"],
    );
  }

  const observed = `${shareValue.returnBps} bps`;

  return shareValue.returnBps >= rule.value
    ? pass("minimumObservedReturn", threshold, observed, references)
    : fail("minimumObservedReturn", threshold, observed, references, []);
}

/**
 * Minimum withdrawable assets.
 *
 * Two ways this is unknown rather than failed: the capability could not be trusted — a revert or the
 * documented non-standard zero, both of which arrive as a null figure — or the reads were taken for
 * a different account than the policy names. Treating either as a real zero would assert the owner
 * cannot withdraw, which no contract said.
 */
function evaluateMinimumWithdrawable(input: EvaluationInput): PolicyRuleResult {
  const rule = input.policy.minWithdrawableAssets;
  const threshold = rule.value;
  const references = ["account_limits.maxWithdraw"];
  const observed = input.draft.observations.maxWithdrawAssets;

  if (input.observedOwner === null) {
    return unknown("minimumWithdrawableAssets", threshold, null, references, ["MISSING_OBSERVATION"]);
  }

  if (input.observedOwner.toLowerCase() !== rule.owner.toLowerCase()) {
    // Evidence for one wallet must never satisfy a rule written about another.
    return unknown("minimumWithdrawableAssets", threshold, null, references, [
      "WALLET_CONTEXT_CHANGED",
    ]);
  }

  if (observed === null) {
    return unknown(
      "minimumWithdrawableAssets",
      threshold,
      null,
      references,
      reasonsFor(input.draft, "AMBIGUOUS_CAPABILITY", "CALL_REVERTED", "UNSUPPORTED_CAPABILITY"),
    );
  }

  return BigInt(observed) >= BigInt(threshold)
    ? pass("minimumWithdrawableAssets", threshold, observed, references)
    : fail("minimumWithdrawableAssets", threshold, observed, references, []);
}

/** Seconds from deployment to the report block, or null when either end is unknown. */
function ageSeconds(input: EvaluationInput): number | null {
  if (input.vaultDeployedAt === null) {
    return null;
  }

  const deployed = Date.parse(input.vaultDeployedAt);
  const asOf = Date.parse(input.draft.asOf.timestamp);

  if (Number.isNaN(deployed) || Number.isNaN(asOf)) {
    return null;
  }

  return Math.round((asOf - deployed) / 1000);
}

/**
 * The reason codes the draft actually recorded, narrowed to those this rule can be affected by.
 *
 * Carrying the draft's own codes keeps the rule's explanation and the evidence's explanation the
 * same explanation. The fallback is used only when the draft recorded nothing relevant, so a rule is
 * never left saying UNKNOWN without saying why.
 */
function reasonsFor(
  draft: EvidenceReportDraft,
  ...candidates: readonly ReasonCode[]
): ReasonCode[] {
  const matched = candidates.filter((code) => draft.reasonCodes.includes(code));

  return matched.length > 0 ? matched : [candidates[0]!];
}

function pass(
  key: PolicyRuleResult["key"],
  threshold: string,
  observedValue: string | null,
  evidenceReferences: string[],
): PolicyRuleResult {
  return { key, status: "PASS", threshold, observedValue, evidenceReferences, reasonCodes: [] };
}

function fail(
  key: PolicyRuleResult["key"],
  threshold: string,
  observedValue: string | null,
  evidenceReferences: string[],
  reasonCodes: ReasonCode[],
): PolicyRuleResult {
  return { key, status: "FAIL", threshold, observedValue, evidenceReferences, reasonCodes };
}

function unknown(
  key: PolicyRuleResult["key"],
  threshold: string,
  observedValue: string | null,
  evidenceReferences: string[],
  reasonCodes: ReasonCode[],
): PolicyRuleResult {
  return { key, status: "UNKNOWN", threshold, observedValue, evidenceReferences, reasonCodes };
}
