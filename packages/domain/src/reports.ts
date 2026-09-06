import { z } from "zod";

import { policyRuleKeySchema, policyRuleStatusSchema, type PolicyRuleKey } from "./policy.js";

/**
 * Enum-like values for the persisted report tables (ERD sections 5 and 6).
 *
 * Same contract as `observations.ts`: these `.options` arrays are what the CHECK constraints in
 * migrations/0002_reports_and_policies.sql are generated from, and a test in @tr4ce/db asserts the
 * two still agree.
 */

/**
 * Overall status of a stored report.
 *
 * `not_evaluated` is the fourth value and is not a variant of the policy truth table: it marks a
 * report generated with no policy attached at all. Collapsing it into `unknown` would make an
 * evidence-only report indistinguishable from one whose rules could not be decided.
 */
export const reportStatusSchema = z.enum(["pass", "fail", "unknown", "not_evaluated"]);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

/**
 * Status of one persisted rule result.
 *
 * Lowercase because ERD section 6 spells the column that way, while `policyRuleStatusSchema` is
 * uppercase in the wire contract. Two spellings of one concept is exactly how enums drift, so the
 * mapping is a function with a test behind it rather than a second hand-maintained list.
 */
export const ruleResultStatusSchema = z.enum(["pass", "fail", "unknown"]);
export type RuleResultStatus = z.infer<typeof ruleResultStatusSchema>;

/** Wire spelling to stored spelling. The only place the two forms are allowed to meet. */
export function persistedRuleStatus(
  status: z.infer<typeof policyRuleStatusSchema>,
): RuleResultStatus {
  return ruleResultStatusSchema.parse(status.toLowerCase());
}

/** Which observation table a `report_observation` row points at. */
export const observationTypeSchema = z.enum(["snapshot", "flow", "rpc_call"]);
export type ObservationType = z.infer<typeof observationTypeSchema>;

/**
 * Why a report cites a particular observation.
 *
 * The report is a claim, and this says which part of the claim each cited row supports. Without it
 * a reader can see that a report used two snapshots but not which one was the window start.
 */
export const observationPurposeSchema = z.enum([
  "start",
  "end",
  "net_flow",
  "account_limit",
  "simulation_input",
]);
export type ObservationPurpose = z.infer<typeof observationPurposeSchema>;

/**
 * How a policy version came to exist.
 *
 * `llm_import` never means "accepted": a drafted policy still passes the strict schema and is still
 * confirmed by a person before it is stored (PRD TR-F-024). The column records provenance so an
 * audit can tell the two apart afterwards.
 */
export const policySourceSchema = z.enum(["manual", "llm_import"]);
export type PolicySource = z.infer<typeof policySourceSchema>;

/**
 * Comparison a normalized `policy_rule` row applies.
 *
 * Only two exist across the five MVP rules, and which one a rule uses is fixed by the rule itself —
 * an allowlist is a membership test, a threshold is a lower bound. Recorded as a column anyway
 * because ERD section 5 asks for rules to be queryable and auditable without parsing the canonical
 * JSON.
 */
export const policyRuleOperatorSchema = z.enum(["in", "gte"]);
export type PolicyRuleOperator = z.infer<typeof policyRuleOperatorSchema>;

/**
 * The operator each rule uses, and the order rules are stored in.
 *
 * A map rather than a `switch` in the repository, so the normalized projection and the canonical
 * policy cannot fall out of step: adding a sixth rule key stops compiling here first.
 */
export const POLICY_RULE_OPERATORS: Readonly<Record<PolicyRuleKey, PolicyRuleOperator>> = {
  underlyingAsset: "in",
  minimumHistory: "gte",
  minimumTvl: "gte",
  minimumObservedReturn: "gte",
  minimumWithdrawableAssets: "gte",
};

/** Stable storage order for the normalized rule rows. */
export const POLICY_RULE_ORDER: readonly PolicyRuleKey[] = policyRuleKeySchema.options;
