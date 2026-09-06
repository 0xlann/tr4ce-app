import { createHash } from "node:crypto";

import {
  canonicalJson,
  POLICY_RULE_OPERATORS,
  policyV1Schema,
  type PolicySource,
  type PolicyV1,
  type PolicyRuleKey,
} from "@tr4ce/domain";
import { eq } from "drizzle-orm";

import type { Executor } from "../client.js";
import { policyId, policyRuleId, policyVersionId, walletId } from "../ids.js";
import { hexToBytes } from "../schema/columns.js";
import { policy, policyRule, policyVersion, wallet } from "../schema/policies.js";

/**
 * Storing a confirmed policy.
 *
 * A policy version is immutable. Re-submitting an identical policy resolves to the row that is
 * already there rather than minting a new version, because a version number that advanced without
 * the policy changing would make the history say something untrue.
 *
 * The wallet a policy belongs to is not a separate parameter: `minWithdrawableAssets.owner` already
 * names the account whose withdrawable balance the policy asks about, and inventing a second notion
 * of "whose policy is this" would let the two disagree.
 */

export interface StoredPolicyVersion {
  walletId: string;
  policyId: string;
  policyVersionId: string;
  contentHash: string;
  versionNumber: number;
  /** The normalized rule rows, in storage order, so a caller can key rule results off them. */
  rules: readonly { id: string; ruleKey: PolicyRuleKey }[];
  /** False when this exact policy was already stored and the existing rows were reused. */
  created: boolean;
}

export interface StorePolicyOptions {
  policy: PolicyV1;
  /** Free text the owner chose. Part of the policy's identity, so two names are two policies. */
  name: string;
  source: PolicySource;
}

/** SHA-256 over the canonical policy JSON, as lowercase hex. */
export function policyContentHash(candidate: PolicyV1): string {
  return createHash("sha256").update(canonicalJson(candidate), "utf8").digest("hex");
}

export async function storePolicyVersion(
  tx: Executor,
  options: StorePolicyOptions,
): Promise<StoredPolicyVersion> {
  // Parsed, not trusted: this is the last point before a policy reaches the database, and the
  // strict schema is what stops an unrecognised key from being stored as though it meant something.
  const parsed = policyV1Schema.parse(options.policy);

  const owner = parsed.minWithdrawableAssets.owner;
  const walletRowId = walletId(owner);
  const policyRowId = policyId(walletRowId, options.name);
  const contentHash = policyContentHash(parsed);
  const versionRowId = policyVersionId(policyRowId, contentHash);

  await tx
    .insert(wallet)
    .values({ id: walletRowId, chainScope: null, address: hexToBytes(owner) })
    .onConflictDoNothing({ target: wallet.id });

  await tx
    .insert(policy)
    .values({ id: policyRowId, walletId: walletRowId, name: options.name })
    .onConflictDoNothing({ target: policy.id });

  const existing = await tx
    .select({ versionNumber: policyVersion.versionNumber })
    .from(policyVersion)
    .where(eq(policyVersion.id, versionRowId));

  const rules = orderedRules(versionRowId, parsed);

  if (existing.length > 0) {
    return {
      walletId: walletRowId,
      policyId: policyRowId,
      policyVersionId: versionRowId,
      contentHash,
      versionNumber: existing[0]!.versionNumber,
      rules,
      created: false,
    };
  }

  // Counted rather than tracked in the application: `(policy_id, version_number)` is unique, so a
  // concurrent writer picking the same number loses the insert instead of silently renumbering.
  const siblings = await tx
    .select({ versionNumber: policyVersion.versionNumber })
    .from(policyVersion)
    .where(eq(policyVersion.policyId, policyRowId));

  const versionNumber = siblings.reduce((highest, row) => Math.max(highest, row.versionNumber), 0) + 1;

  await tx.insert(policyVersion).values({
    id: versionRowId,
    policyId: policyRowId,
    versionNumber,
    schemaVersion: "1.0.0",
    canonicalJson: parsed,
    contentHash: hexToBytes(`0x${contentHash}`),
    source: options.source,
    // A typed policy submitted directly is a confirmed one: the caller wrote it out in full rather
    // than accepting a draft. A model-drafted policy reaches this function only after a person has
    // confirmed it, which is what `source` records (PRD TR-F-024).
    confirmedAt: new Date(),
  });

  // Written in the same transaction as the version they project, as ERD section 5 requires.
  await tx.insert(policyRule).values(
    rules.map((rule, ordinal) => ({
      id: rule.id,
      policyVersionId: versionRowId,
      ruleKey: rule.ruleKey,
      operator: POLICY_RULE_OPERATORS[rule.ruleKey],
      valueJson: rule.value,
      ordinal,
    })),
  );

  return {
    walletId: walletRowId,
    policyId: policyRowId,
    policyVersionId: versionRowId,
    contentHash,
    versionNumber,
    rules,
    created: true,
  };
}

/** Read back the canonical policy a stored version holds. */
export async function readPolicyVersion(
  tx: Executor,
  versionRowId: string,
): Promise<PolicyV1 | null> {
  const rows = await tx
    .select({ canonicalJson: policyVersion.canonicalJson })
    .from(policyVersion)
    .where(eq(policyVersion.id, versionRowId));

  // Parsed on the way out as well as in. A row that no longer satisfies the schema is a signal,
  // not something to hand to an evaluator.
  return rows.length === 0 ? null : policyV1Schema.parse(rows[0]!.canonicalJson);
}

interface NormalizedRule {
  id: string;
  ruleKey: PolicyRuleKey;
  value: unknown;
}

/**
 * The canonical policy projected onto one row per rule.
 *
 * Exhaustive by construction: the five keys come from the domain enum, so a sixth rule fails to
 * compile here rather than being quietly dropped from the projection.
 */
function orderedRules(versionRowId: string, parsed: PolicyV1): NormalizedRule[] {
  const values: Record<PolicyRuleKey, unknown> = {
    underlyingAsset: parsed.underlyingAssets,
    minimumHistory: parsed.minHistoryDays,
    minimumTvl: parsed.minTvlAssets,
    minimumObservedReturn: parsed.minObservedReturnBps,
    minimumWithdrawableAssets: parsed.minWithdrawableAssets,
  };

  return (Object.keys(values) as PolicyRuleKey[]).map((ruleKey) => ({
    id: policyRuleId(versionRowId, ruleKey),
    ruleKey,
    value: values[ruleKey],
  }));
}
