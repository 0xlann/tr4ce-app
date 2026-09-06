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
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <p className="monoLabel">Immutable evidence report</p>
          <h1 className={`display ${styles.title}`}>{name}</h1>
          <p className={styles.meta}>
            {protocol} · Base · <code>{report.vault.address}</code>
          </p>
        </div>
        <StatusStamp reason={reason} size="feature" status={report.policy.status} />
      </header>

      <div className={styles.context} data-reveal>
        <span>As of block <strong className="num">{report.asOf.blockNumber}</strong></span>
        <span className={styles.contextDivider} aria-hidden="true" />
        <span>{new Date(report.asOf.timestamp).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</span>
        <span className={styles.contextDivider} aria-hidden="true" />
        <span>{report.calculationVersion}</span>
        <ProvenanceChip entries={report.provenance} />
      </div>

      <section aria-label="Key observations" className={styles.metrics} data-reveal>
        <div>
          <p className="monoLabel">Observed share-value return</p>
          <strong className={`num ${styles.metricValue}`}>
            {report.observations.shareValue.returnBps >= 0 ? "+" : ""}{(report.observations.shareValue.returnBps / 100).toFixed(2)}%
          </strong>
          <span>{report.observations.shareValue.windowDays} days · USDC share conversion</span>
        </div>
        <div>
          <p className="monoLabel">Total assets</p>
          <strong className={`num ${styles.metricValue}`}>{formatUsdcMillions(report.observations.totalAssets)}</strong>
          <span>At the report block</span>
        </div>
        <div>
          <p className="monoLabel">Withdrawal capacity</p>
          <strong className={`num ${styles.metricValue}`}>
            {report.observations.maxWithdrawAssets === null ? "N/A" : formatUsdc(report.observations.maxWithdrawAssets)}
          </strong>
          <span>{report.observations.maxWithdrawAssets === null ? "Adapter semantics unresolved" : "Account scoped"}</span>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLead}>
          <h2 className="display">Every rule <em className="serifAccent">remains visible.</em></h2>
          <span className={styles.sectionTag}>Illustrative policy v{report.policy.version}</span>
        </div>
        <div className={styles.rules}>
          {report.policy.rules.map((rule) => (
            <article className={styles.ruleRow} key={rule.key}>
              <div className={styles.ruleName}>
                <strong>{ruleLabels[rule.key]}</strong>
                <span>Threshold: {rule.threshold}</span>
              </div>
              <div className={styles.ruleObserved}>
                <span className={`num ${styles.observedValue}`}>{rule.observedValue ?? "Unavailable"}</span>
                <small>{rule.evidenceReferences.join(", ")}</small>
              </div>
              <StatusStamp reason={rule.reasonCodes[0] ?? "Rule passed."} status={rule.status} />
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLead}>
          <h2 className="display">Do not <em className="serifAccent">smooth</em> the evidence.</h2>
        </div>
        <BlockRuler end={report.asOf.blockNumber} start="50577041" />
        <div className={styles.chartWrap}>
          <ShareValueChart />
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionLead}>
          <h2 className="display">Inputs stay <em className="serifAccent">inspectable.</em></h2>
        </div>
        <div className={`cardPanel ${styles.calculation}`}>
          <code className={styles.formula}>return bps = (assets now / assets at start − 1) × 10,000</code>
          <dl className={styles.calcList}>
            <div><dt>Assets at start</dt><dd className="num">{report.observations.shareValue.assetsAtStart}</dd></div>
            <div><dt>Assets now</dt><dd className="num">{report.observations.shareValue.assetsNow}</dd></div>
            <div><dt>Net flow assets</dt><dd className="num">{report.observations.netFlowAssets}</dd></div>
            <div><dt>Rounding</dt><dd>Floor, illustrative display</dd></div>
          </dl>
        </div>
      </section>

      <section className={styles.section}>
        <LimitationCallout limitations={report.limitations} />
      </section>

      <section className={styles.action}>
        <div>
          <h2 className={`display ${styles.actionTitle}`}>Ready to act on this evidence?</h2>
          <p>Review the exact unsigned calldata before any wallet approval — preparation is not execution.</p>
        </div>
        <Link className="pill pillGreen" href="/actions/act_gauntletDeposit01">Prepare action</Link>
      </section>

      <details className={styles.json} id="json">
        <summary>View illustrative report JSON</summary>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </article>
  );
}
