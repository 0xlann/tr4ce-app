"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { formatUsdc, formatUsdcMillions } from "../../src/demo/display";
import { getPolicyPreset, getVaultSummaries } from "../../src/demo/fixtures";
import type { PolicyPreset } from "../../src/demo/types";
import { DataStateBanner } from "../ui/DataStateBanner";
import { SectionHeading } from "../ui/SectionHeading";
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
      <main id="main-content" className={styles.main}>
        <SectionHeading eyebrow="CURATED USDC EVIDENCE" title="Compare the policy. Then inspect the trace." detail="Illustrative fixtures use verified Base vault identities. No wallet or live provider is connected." />
        <section className={styles.layout}>
          <aside className={`${styles.policy} specimenFrame`}>
            <p className={styles.eyebrow}>POLICY v{policy.version}</p>
            <h2>Evidence check</h2>
            <div className={styles.presets}>{presets.map((item) => <button aria-pressed={preset === item} className={preset === item ? styles.activePreset : ""} key={item} onClick={() => setPreset(item)} type="button">{item}</button>)}</div>
            <dl>
              <div><dt>Asset</dt><dd>USDC</dd></div>
              <div><dt>Minimum history</dt><dd>{policy.minHistoryDays} days</dd></div>
              <div><dt>Minimum TVL</dt><dd>{formatUsdcMillions(policy.minTvlAssets)}</dd></div>
              <div><dt>Return window</dt><dd>{policy.minObservedReturnBps.windowDays} days</dd></div>
              <div><dt>Withdrawal floor</dt><dd>{formatUsdc(policy.minWithdrawableAssets.value)}</dd></div>
            </dl>
            <button className={styles.usePolicy} type="button">Use this policy</button>
          </aside>
          <div className={styles.results}>
            <div className={styles.summary}>
              <div><strong>{vaults.filter((vault) => vault.report.policy.status === "PASS").length}</strong><span>passing</span></div>
              <div><strong>{vaults.filter((vault) => vault.report.policy.status === "FAIL").length}</strong><span>failing</span></div>
              <div><strong>{vaults.filter((vault) => vault.report.policy.status === "UNKNOWN").length}</strong><span>unknown</span></div>
              <p>Sorted by policy, completeness, then name.</p>
            </div>
            <div className={styles.tableWrap}>
              <table>
                <caption>Illustrative policy results at Base block 50,879,897</caption>
                <thead><tr><th>Vault</th><th>Policy</th><th>Complete</th><th>Observed return</th><th>TVL</th><th>Withdrawal</th><th><span className="srOnly">Report</span></th></tr></thead>
                <tbody>{vaults.map((vault) => <tr key={vault.id}><th scope="row"><strong>{vault.name}</strong><span>{vault.network} · {vault.protocol}</span><code>{vault.address}</code></th><td><StatusStamp reason={vault.report.policy.rules.find((rule) => rule.status !== "PASS")?.reasonCodes[0] ?? "All five illustrative policy rules passed."} status={vault.report.policy.status} /></td><td>{vault.completeness}%</td><td>{vault.report.observations.shareValue.returnBps >= 0 ? "+" : ""}{(vault.report.observations.shareValue.returnBps / 100).toFixed(2)}%<small>{vault.report.observations.shareValue.windowDays} days</small></td><td>{formatUsdcMillions(vault.report.observations.totalAssets)}</td><td>{vault.report.observations.maxWithdrawAssets === null ? "Unavailable" : formatUsdc(vault.report.observations.maxWithdrawAssets)}</td><td><Link href={`/reports/${vault.id}`}>Inspect</Link></td></tr>)}</tbody>
              </table>
            </div>
            <section className={styles.addressCheck}>
              <label htmlFor="vault-address">Check one address</label>
              <div><input id="vault-address" onChange={(event) => setAddress(event.target.value)} placeholder="0x..." value={address} /><button type="button">Check address</button></div>
              {address.length > 0 ? <p>Illustrative diagnostics only. Connect the API after Task 6 to verify an entered address.</p> : null}
            </section>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
