"use client";

import type { PolicyV1 } from "@tr4ce/domain";

import type { EvaluationIssue } from "../../src/api/evaluation";
import { asPolicy, pathFor, presets, type PolicyDraft } from "./policy-draft";
import { formatUsdc, formatUsdcMillions } from "../../src/demo/display";
import styles from "./PolicyBuilder.module.css";

export { draftToPolicy, presets, type PolicyDraft } from "./policy-draft";

/**
 * The five-rule policy, editable.
 *
 * Every field is required. `policyV1Schema` has no optional rule and says why: a policy a user
 * cannot fully see is not one they can meaningfully confirm. So this panel shows all five, always,
 * with the units spelled out beside them.
 *
 * Validation is not performed here. The draft is posted to `POST /v1/policies/evaluate`, which
 * accepts `z.unknown()` and answers with issues rather than a rejection (TR-F-024) — so the
 * authority on what a valid policy is stays in one place, and this panel renders what it is told.
 * A second copy of the rules in the browser is exactly the drift that would let the two disagree.
 */

type PolicyBuilderProps = {
  draft: PolicyDraft;
  issues: readonly EvaluationIssue[];
  pending: boolean;
  onChange: (draft: PolicyDraft) => void;
  onEvaluate: () => void;
};

const fields: {
  key: keyof PolicyDraft;
  label: string;
  hint: string;
  inputMode: "numeric" | "text";
}[] = [
  { key: "minHistoryDays", label: "Minimum history", hint: "days", inputMode: "numeric" },
  { key: "minTvlAssets", label: "Minimum TVL", hint: "USDC base units (6 decimals)", inputMode: "numeric" },
  { key: "returnWindowDays", label: "Return window", hint: "days", inputMode: "numeric" },
  { key: "minObservedReturnBps", label: "Minimum observed return", hint: "basis points, may be negative", inputMode: "numeric" },
  { key: "owner", label: "Withdrawal owner", hint: "address the limit is read for", inputMode: "text" },
  { key: "minWithdrawableAssets", label: "Withdrawal floor", hint: "USDC base units (6 decimals)", inputMode: "numeric" },
];

export function PolicyBuilder({ draft, issues, pending, onChange, onEvaluate }: PolicyBuilderProps) {
  const policy = asPolicy(draft);

  return (
    <form
      className={`periPanel ${styles.panel}`}
      onSubmit={(event) => {
        event.preventDefault();
        onEvaluate();
      }}
    >
      <div className={styles.head}>
        <h2 className={styles.title}>Policy</h2>
        <span className={styles.version}>v1 · five rules</span>
      </div>

      <div aria-label="Start from a preset" className={styles.presets} role="group">
        {(Object.keys(presets) as (keyof typeof presets)[]).map((name) => (
          <button
            className={styles.preset}
            key={name}
            onClick={() => onChange(presets[name])}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>

      {/* Fixed, and shown rather than hidden: the MVP evaluates USDC vaults only, and a rule the
          user cannot see is a rule they cannot confirm. */}
      <p className={styles.fixed}>
        <span className={styles.fixedLabel}>Underlying asset</span>
        <span className={styles.fixedValue}>USDC</span>
      </p>

      <div className={styles.fields}>
        {fields.map((field) => {
          // Exact, not prefix: `minObservedReturnBps` is a prefix of
          // `minObservedReturnBps.windowDays`, and a prefix match would show the window's issue
          // under the value's field as well.
          const fieldIssues = issues.filter((issue) => issue.path === pathFor(field.key));

          return (
            <div className={styles.field} key={field.key}>
              <label htmlFor={`policy-${field.key}`}>{field.label}</label>
              <input
                aria-describedby={`policy-${field.key}-hint`}
                aria-invalid={fieldIssues.length > 0}
                className={fieldIssues.length > 0 ? styles.inputInvalid : styles.input}
                id={`policy-${field.key}`}
                inputMode={field.inputMode}
                onChange={(event) => onChange({ ...draft, [field.key]: event.target.value })}
                spellCheck={false}
                value={draft[field.key]}
              />
              <p className={styles.hint} id={`policy-${field.key}-hint`}>
                {field.hint}
                {preview(field.key, policy) === null ? null : (
                  <span className={styles.preview}> · {preview(field.key, policy)}</span>
                )}
              </p>
              {fieldIssues.map((issue) => (
                <p className={styles.issue} key={issue.path + issue.message} role="alert">
                  {issue.message}
                </p>
              ))}
            </div>
          );
        })}
      </div>

      <button className="pill pillGreen" disabled={pending} type="submit">
        {pending ? "Evaluating…" : "Evaluate policy"}
      </button>

      <p className={styles.note}>
        Nothing is stored. Evaluating a candidate policy is a question, not a claim.
      </p>
    </form>
  );
}

/** Base units are what the API takes; this shows what they mean without changing what is sent. */
function preview(key: keyof PolicyDraft, policy: PolicyV1 | null): string | null {
  if (policy === null) {
    return null;
  }

  if (key === "minTvlAssets") {
    return formatUsdcMillions(policy.minTvlAssets);
  }

  if (key === "minWithdrawableAssets") {
    return formatUsdc(policy.minWithdrawableAssets.value);
  }

  if (key === "minObservedReturnBps") {
    return `${(policy.minObservedReturnBps.value / 100).toFixed(2)}%`;
  }

  return null;
}
