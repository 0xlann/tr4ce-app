"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { formatUsdc, formatUsdcMillions } from "../../src/demo/display";
import { getPolicyPreset, getVaultSummaries } from "../../src/demo/fixtures";
import type { PolicyPreset } from "../../src/demo/types";
import { DataStateBanner } from "../ui/DataStateBanner";
import { SiteFooter } from "../ui/SiteFooter";
import { SiteHeader } from "../ui/SiteHeader";
import { StatusStamp } from "../ui/StatusStamp";
import { compareVaults } from "./compare-vaults";
import styles from "./SearchSurface.module.css";

const presets: PolicyPreset[] = ["strict", "balanced", "lenient"];

export function SearchSurface() {
  const [preset, setPreset] = useState<PolicyPreset>("balanced");
  const [address, setAddress] = useState("");
  const policy = getPolicyPreset(preset);
  const vaults = useMemo(() => compareVaults(getVaultSummaries(preset)), [preset]);

  return (
    <>
      <SiteHeader />
      <DataStateBanner />
      <main id="main-content">
        <header className={`shell ${styles.lead}`}>
          <h1 className={`display ${styles.leadTitle}`} data-reveal>
            Compare the policy. <em className="serifAccent">Then inspect the trace.</em>
          </h1>
          <p className="lede" data-reveal data-reveal-delay="0.1">
            Curated USDC evidence on verified Base vault identities. The same typed five-rule policy
            drives every verdict. Switch it and watch each verdict follow.
          </p>
        </header>

        <div className={`shell ${styles.layout}`}>
          <aside aria-label="Policy configuration" className={styles.policyCol}>
            <div className={`periPanel ${styles.policy}`} data-reveal>
              <div className={styles.policyHead}>
                <p className={styles.policyName}>{preset}</p>
                <span className={styles.version}>v{policy.version}</span>
              </div>
              <div aria-label="Policy preset" className={styles.presets} role="group">
                {presets.map((item) => (
                  <button
                    aria-pressed={preset === item}
                    className={preset === item ? styles.activePreset : styles.preset}
                    key={item}
                    onClick={() => setPreset(item)}
                    type="button"
                  >
                    {item}
                  </button>
                ))}
              </div>
              <dl className={styles.ruleList}>
                <div><dt>Underlying asset</dt><dd>USDC</dd></div>
                <div><dt>Minimum history</dt><dd className="num">{policy.minHistoryDays} days</dd></div>
                <div><dt>Minimum TVL</dt><dd className="num">{formatUsdcMillions(policy.minTvlAssets)}</dd></div>
                <div><dt>Return window</dt><dd className="num">{policy.minObservedReturnBps.windowDays} days</dd></div>
                <div><dt>Withdrawal floor</dt><dd className="num">{formatUsdc(policy.minWithdrawableAssets.value)}</dd></div>
              </dl>
              <button className="pill pillGreen pillSmall" type="button">Use this policy</button>
              <p className={styles.policyNote}>Illustrative preset. The hosted API wires this to live evidence.</p>
            </div>
          </aside>

          <section aria-label="Policy results" className={styles.results}>
            <div className={styles.summary} data-reveal>
              <div className={styles.summaryItem}>
                <strong className="num">{vaults.filter((vault) => vault.report.policy.status === "PASS").length}</strong>
                <span>passing</span>
              </div>
              <div className={styles.summaryItem}>
                <strong className="num">{vaults.filter((vault) => vault.report.policy.status === "FAIL").length}</strong>
                <span>failing</span>
              </div>
              <div className={styles.summaryItem}>
                <strong className="num">{vaults.filter((vault) => vault.report.policy.status === "UNKNOWN").length}</strong>
                <span>unknown</span>
              </div>
              <p className={styles.summaryNote}>Illustrative results at Base block <span className="num">50,879,897</span>. Sorted by policy, completeness, then name.</p>
            </div>

            <div className={`cardPanel ${styles.tableCard}`} data-reveal data-reveal-delay="0.08">
              <p aria-hidden="true" className={styles.scrollHint}>Swipe the ledger sideways for every column</p>
              <table className={styles.table}>
                <caption className="srOnly">Illustrative policy results at Base block 50,879,897</caption>
                <thead>
                  <tr>
                    <th scope="col">Vault</th>
                    <th scope="col">Verdict</th>
                    <th scope="col" className={styles.right}>Observed return</th>
                    <th scope="col" className={styles.right}>TVL</th>
                    <th scope="col" className={styles.right}>Withdrawal</th>
                    <th scope="col"><span className="srOnly">Report</span></th>
                  </tr>
                </thead>
                <tbody>
                  {vaults.map((vault) => (
                    <tr key={vault.id}>
                      <th scope="row">
                        <span className={styles.vaultName}>{vault.name}</span>
                        <span className={styles.vaultMeta}>{vault.network} · {vault.protocol}</span>
                        <code className={styles.vaultAddress}>{vault.address}</code>
                      </th>
                      <td>
                        <StatusStamp
                          reason={vault.report.policy.rules.find((rule) => rule.status !== "PASS")?.reasonCodes[0] ?? "All five illustrative policy rules passed."}
                          status={vault.report.policy.status}
                        />
                      </td>
                      <td className={`num ${styles.right}`}>
                        <strong className={vault.report.observations.shareValue.returnBps >= 0 ? styles.up : styles.down}>
                          {vault.report.observations.shareValue.returnBps >= 0 ? "+" : ""}{(vault.report.observations.shareValue.returnBps / 100).toFixed(2)}%
                        </strong>
                        <small>{vault.report.observations.shareValue.windowDays} days</small>
                      </td>
                      <td className={`num ${styles.right}`}>{formatUsdcMillions(vault.report.observations.totalAssets)}</td>
                      <td className={`num ${styles.right}`}>
                        {vault.report.observations.maxWithdrawAssets === null
                          ? <span className={styles.unavailable}>Unavailable</span>
                          : formatUsdc(vault.report.observations.maxWithdrawAssets)}
                      </td>
                      <td>
                        <Link className={styles.inspect} href={`/reports/${vault.id}`}>
                          Inspect
                          <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 16 16"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" /></svg>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <section className={`cardPanel ${styles.addressCheck}`} data-reveal>
              <div className={styles.addressCopy}>
                <h2 className={styles.addressTitle}>Check one address</h2>
                <p>Enter a USDC vault on Base. Diagnostics stay illustrative until the API is connected.</p>
              </div>
              <form className={styles.addressForm} onSubmit={(event) => event.preventDefault()}>
                <label className="srOnly" htmlFor="vault-address">Vault address</label>
                <input
                  id="vault-address"
                  className={styles.addressInput}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  value={address}
                />
                <button className="pill pillGreen pillSmall" type="submit">Check address</button>
              </form>
              {address.length > 0 ? (
                <p className={styles.addressNote} role="status">
                  Illustrative diagnostics only. The hosted API will verify{" "}
                  <code>{address}</code>.
                </p>
              ) : null}
            </section>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
