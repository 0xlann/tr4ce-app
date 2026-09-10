"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PolicyBuilder, draftToPolicy, presets, type PolicyDraft } from "../policy/PolicyBuilder";
import { evaluationResponseSchema, type EvaluationOutcome } from "../../src/api/evaluation";
import { formatUsdc, formatUsdcMillions } from "../../src/demo/display";
import { DataStateBanner } from "../ui/DataStateBanner";
import { SiteFooter } from "../ui/SiteFooter";
import { SiteHeader } from "../ui/SiteHeader";
import { StatusStamp } from "../ui/StatusStamp";
import { compareOutcomes } from "./compare-outcomes";
import { formatBasisPoints, isWholeInteger } from "./observed-value";
import type { VaultRow } from "./vault-row";
import styles from "./SearchSurface.module.css";

/**
 * Compare vaults against a policy the user wrote.
 *
 * The vault list arrives from the server, already read from `GET /v1/vaults`. Everything after that
 * is a question the user asks: the draft policy is posted to `/api/evaluate`, which fans out to the
 * evidence API and answers per vault. Nothing on this page is stored — evaluating a candidate policy
 * is a question, not a claim, and the route that answers it says so.
 *
 * Inspecting a result is the point where something *is* written. `POST /v1/reports` mints the
 * immutable report the user then has a URL for, and the button says so.
 */

const WINDOW_DAYS = 7;

type SearchSurfaceProps = {
  chainId: number;
  vaults: readonly VaultRow[];
  /** Set when the registry itself could not be read. */
  unavailable: string | null;
};

export function SearchSurface({ chainId, vaults, unavailable }: SearchSurfaceProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<PolicyDraft>(presets.balanced);
  const [outcomes, setOutcomes] = useState<readonly EvaluationOutcome[] | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [address, setAddress] = useState("");

  const issues = outcomes?.flatMap((outcome) => outcome.issues) ?? [];

  async function evaluate() {
    setPending(true);
    setFailure(null);

    try {
      const response = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId,
          vaultAddresses: vaults.map((vault) => vault.address),
          windowDays: WINDOW_DAYS,
          policy: draftToPolicy(draft),
        }),
      });

      const body: unknown = await response.json();

      if (!response.ok) {
        // The draft did not even reach the evaluator. Surfaced as a blocking message rather than
        // an empty table, which would read as "no vault matched".
        setFailure(messageOf(body));
        setOutcomes(null);

        return;
      }

      setOutcomes(evaluationResponseSchema.parse(body).outcomes);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  async function inspect(vaultAddress: string) {
    setInspecting(vaultAddress);
    setFailure(null);

    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId,
          vaultAddress,
          windowDays: WINDOW_DAYS,
          policy: draftToPolicy(draft),
        }),
      });

      const body: unknown = await response.json();

      if (!response.ok) {
        setFailure(messageOf(body));

        return;
      }

      router.push(`/reports/${(body as { reportId: string }).reportId}`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setInspecting(null);
    }
  }

  const rows = outcomes === null ? [] : compareOutcomes(vaults, outcomes);
  const counted = (status: "PASS" | "FAIL" | "UNKNOWN") =>
    rows.filter((row) => row.outcome.status === status).length;

  const known = vaults.find((vault) => vault.address.toLowerCase() === address.trim().toLowerCase());

  return (
    <>
      <SiteHeader />
      <DataStateBanner state={unavailable === null ? "fresh" : "partial"} detail={unavailable} />
      <main id="main-content">
        <header className={`shell ${styles.lead}`}>
          <h1 className={`display ${styles.leadTitle}`} data-reveal>
            Compare the policy. <em className="serifAccent">Then inspect the trace.</em>
          </h1>
          <p className="lede" data-reveal data-reveal-delay="0.1">
            Verified USDC vault identities on Base. Write the five rules yourself, then watch each
            verdict follow from the evidence rather than from a ranking.
          </p>
        </header>

        <div className={`shell ${styles.layout}`}>
          <aside aria-label="Policy configuration" className={styles.policyCol}>
            <PolicyBuilder
              draft={draft}
              issues={issues}
              onChange={setDraft}
              onEvaluate={evaluate}
              pending={pending}
            />
          </aside>

          <section aria-label="Policy results" className={styles.results}>
            {failure === null ? null : (
              // assertive: this blocks the action the user just took. DESIGN-SYSTEMS section 13
              // reserves it for exactly that and asks for polite everywhere else.
              <p className={styles.failure} role="alert">
                {failure}
              </p>
            )}

            <div aria-live="polite" className={styles.summary} data-reveal>
              {outcomes === null ? (
                <p className={styles.summaryNote}>
                  {pending
                    ? "Reading evidence for each vault…"
                    : `${vaults.length} verified vault${vaults.length === 1 ? "" : "s"}. Evaluate the policy to see a verdict.`}
                </p>
              ) : (
                <>
                  <div className={styles.summaryItem}>
                    <strong className="num">{counted("PASS")}</strong>
                    <span>passing</span>
                  </div>
                  <div className={styles.summaryItem}>
                    <strong className="num">{counted("FAIL")}</strong>
                    <span>failing</span>
                  </div>
                  <div className={styles.summaryItem}>
                    <strong className="num">{counted("UNKNOWN")}</strong>
                    <span>unknown</span>
                  </div>
                  <p className={styles.summaryNote}>
                    Evaluated over {WINDOW_DAYS} days. Sorted by policy status, then by how much
                    evidence was available, then by name.
                  </p>
                </>
              )}
            </div>

            {rows.length === 0 ? null : (
              <div className={`cardPanel ${styles.tableCard}`} data-reveal data-reveal-delay="0.08">
                <p aria-hidden="true" className={styles.scrollHint}>Swipe the ledger sideways for every column</p>
                <table className={styles.table}>
                  <caption className="srOnly">
                    Policy results per vault, with the observed value each rule read
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Vault</th>
                      <th scope="col">Verdict</th>
                      <th className={styles.right} scope="col">Observed return</th>
                      <th className={styles.right} scope="col">TVL</th>
                      <th className={styles.right} scope="col">Withdrawal</th>
                      <th scope="col"><span className="srOnly">Report</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.vault.address}>
                        <th scope="row">
                          <span className={styles.vaultName}>{row.vault.name ?? row.vault.symbol ?? "Vault"}</span>
                          <span className={styles.vaultMeta}>Base · {row.vault.adapterKey}</span>
                          <code className={styles.vaultAddress}>{row.vault.address}</code>
                        </th>
                        <td>
                          {row.outcome.status === null ? (
                            <span className={styles.unavailable}>{row.outcome.unavailable ?? "No verdict"}</span>
                          ) : (
                            <StatusStamp reason={reasonFor(row.outcome)} status={row.outcome.status} />
                          )}
                        </td>
                        <td className={`num ${styles.right}`}>{returnCell(row.outcome, styles)}</td>
                        <td className={`num ${styles.right}`}>{amountCell(row.outcome, "minimumTvl", formatUsdcMillions, styles)}</td>
                        <td className={`num ${styles.right}`}>{amountCell(row.outcome, "minimumWithdrawableAssets", formatUsdc, styles)}</td>
                        <td>
                          <button
                            className={styles.inspect}
                            disabled={inspecting !== null}
                            onClick={() => inspect(row.vault.address)}
                            type="button"
                          >
                            {inspecting === row.vault.address ? "Recording…" : "Inspect"}
                            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 16 16"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" /></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className={styles.tableNote}>
                  Inspecting records an immutable report at the block it was read, and gives it a URL.
                </p>
              </div>
            )}

            <section className={`cardPanel ${styles.addressCheck}`} data-reveal>
              <div className={styles.addressCopy}>
                <h2 className={styles.addressTitle}>Check one address</h2>
                <p>TR4CE reports only on vaults with a recorded source and verification block.</p>
              </div>
              <form className={styles.addressForm} onSubmit={(event) => event.preventDefault()}>
                <label className="srOnly" htmlFor="vault-address">Vault address</label>
                <input
                  className={styles.addressInput}
                  id="vault-address"
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  value={address}
                />
              </form>
              {address.trim().length === 0 ? null : (
                <p className={styles.addressNote} role="status">
                  {known === undefined ? (
                    <>
                      <code>{address.trim()}</code> is not in the verified registry, so there is no
                      evidence to report on it.
                    </>
                  ) : (
                    <>
                      <code>{known.address}</code> is verified as{" "}
                      <strong>{known.name ?? known.symbol ?? "a vault"}</strong>, holding{" "}
                      {known.assetSymbol ?? "its asset"}.
                    </>
                  )}
                </p>
              )}
            </section>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

/** The first rule that did not pass, which is what a verdict most needs explaining by. */
function reasonFor(outcome: EvaluationOutcome): string {
  const failing = outcome.rules?.find((rule) => rule.status !== "PASS");

  if (failing === undefined) {
    return "Every rule passed against the observations at this block.";
  }

  return failing.reasonCodes[0] ?? `${failing.key} is ${failing.status}`;
}

function returnCell(outcome: EvaluationOutcome, css: Record<string, string>) {
  const rule = outcome.rules?.find((candidate) => candidate.key === "minimumObservedReturn");
  const formatted = formatBasisPoints(rule?.observedValue ?? null);

  if (formatted === null) {
    // Unavailable, not zero. A zero here would assert the vault's share value did not move.
    return <span className={css["unavailable"]}>Unavailable</span>;
  }

  return (
    <>
      <strong className={formatted.negative ? css["down"] : css["up"]}>{formatted.text}</strong>
      <small>{WINDOW_DAYS} days</small>
    </>
  );
}

function amountCell(
  outcome: EvaluationOutcome,
  key: string,
  format: (value: string) => string,
  css: Record<string, string>,
) {
  const rule = outcome.rules?.find((candidate) => candidate.key === key);
  const observed = rule?.observedValue ?? null;

  if (observed === null) {
    return <span className={css["unavailable"]}>Unavailable</span>;
  }

  /*
   * Only reformatted when the evaluator handed back a bare integer. It formats each value for the
   * unit its rule is about, and re-reading one of those strings as base units would turn
   * "0.23 days" into an amount of USDC.
   */
  return isWholeInteger(observed) ? format(observed.trim()) : observed;
}

function messageOf(body: unknown): string {
  const error = (body as { error?: { message?: unknown } } | null)?.error?.message;

  return typeof error === "string" ? error : "The evaluation could not be completed.";
}
