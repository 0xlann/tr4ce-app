import type { EvidenceReportV1 } from "@tr4ce/domain";
import Link from "next/link";

import { formatUsdc, formatUsdcMillions } from "../../src/demo/display";
import { BlockRuler } from "../ui/BlockRuler";
import { LimitationCallout } from "../ui/LimitationCallout";
import { ProvenanceChip } from "../ui/ProvenanceChip";
import { StatusStamp } from "../ui/StatusStamp";
import { ShareValueChart } from "./ShareValueChart";
import styles from "./ReportDossier.module.css";

type ReportDossierProps = { name: string; protocol: string; report: EvidenceReportV1 };

const ruleLabels = {
  underlyingAsset: "Underlying asset",
  minimumHistory: "Minimum history",
  minimumTvl: "Minimum TVL",
  minimumObservedReturn: "Observed share-value return",
  minimumWithdrawableAssets: "Withdrawable assets",
} as const;

export function ReportDossier({ name, protocol, report }: ReportDossierProps) {
  const failingRule = report.policy.rules.find((rule) => rule.status !== "PASS");
  const reason = failingRule?.reasonCodes[0] ?? "All five illustrative policy rules passed.";

  return (
    <article className={styles.report}>
      <header className={styles.header}><div><p>IMMUTABLE EVIDENCE REPORT</p><h1>{name}</h1><span>{protocol} · Base · <code>{report.vault.address}</code></span></div><StatusStamp reason={reason} size="feature" status={report.policy.status} /></header>
      <div className={styles.context}><span>As of block <strong>{report.asOf.blockNumber}</strong></span><span>{new Date(report.asOf.timestamp).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</span><span>{report.calculationVersion}</span><ProvenanceChip entries={report.provenance} /></div>
      <section className={styles.metrics}><div><p>OBSERVED SHARE-VALUE RETURN</p><strong>{report.observations.shareValue.returnBps >= 0 ? "+" : ""}{(report.observations.shareValue.returnBps / 100).toFixed(2)}%</strong><span>{report.observations.shareValue.windowDays} days · USDC share conversion</span></div><div><p>TOTAL ASSETS</p><strong>{formatUsdcMillions(report.observations.totalAssets)}</strong><span>At the report block</span></div><div><p>WITHDRAWAL CAPACITY</p><strong>{report.observations.maxWithdrawAssets === null ? "Unavailable" : formatUsdc(report.observations.maxWithdrawAssets)}</strong><span>{report.observations.maxWithdrawAssets === null ? "Adapter semantics unresolved" : "Account scoped"}</span></div></section>
      <section className={styles.section}><div className={styles.sectionLead}><div><p>POLICY EVALUATION</p><h2>Every rule remains visible.</h2></div><span>Illustrative policy v{report.policy.version}</span></div><div className={styles.rules}>{report.policy.rules.map((rule) => <article key={rule.key}><div><strong>{ruleLabels[rule.key]}</strong><span>Threshold: {rule.threshold}</span></div><div><span className={styles.observed}>{rule.observedValue ?? "Unavailable"}</span><small>{rule.evidenceReferences.join(", ")}</small></div><StatusStamp reason={rule.reasonCodes[0] ?? "Rule passed."} status={rule.status} /></article>)}</div></section>
      <section className={styles.section}><div className={styles.sectionLead}><div><p>OBSERVATION WINDOW</p><h2>Do not smooth the evidence.</h2></div></div><BlockRuler end={report.asOf.blockNumber} start="50577041" /><div className={styles.chartWrap}><ShareValueChart /></div></section>
      <section className={styles.section}><div className={styles.sectionLead}><div><p>CALCULATION AND FLOW</p><h2>Inputs stay inspectable.</h2></div><Link href="#json">View JSON</Link></div><div className={styles.calculation}><code>return bps = (assets now / assets at start - 1) × 10,000</code><dl><div><dt>Assets at start</dt><dd>{report.observations.shareValue.assetsAtStart}</dd></div><div><dt>Assets now</dt><dd>{report.observations.shareValue.assetsNow}</dd></div><div><dt>Net flow assets</dt><dd>{report.observations.netFlowAssets}</dd></div><div><dt>Rounding</dt><dd>Floor, illustrative display</dd></div></dl></div></section>
      <section className={styles.section}><LimitationCallout limitations={report.limitations} /></section>
      <section className={styles.action}><div><p>PREPARED ACTION</p><h2>Review exact transaction data before wallet approval.</h2></div><Link href="/actions/act_gauntletDeposit01">Prepare action</Link></section>
      <details className={styles.json} id="json"><summary>View illustrative report JSON</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
    </article>
  );
}
