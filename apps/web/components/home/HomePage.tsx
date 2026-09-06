import Link from "next/link";

import { getReport } from "../../src/demo/fixtures";
import { BlockRuler } from "../ui/BlockRuler";
import { DataStateBanner } from "../ui/DataStateBanner";
import { LimitationCallout } from "../ui/LimitationCallout";
import { SectionHeading } from "../ui/SectionHeading";
import { SiteFooter } from "../ui/SiteFooter";
import { SiteHeader } from "../ui/SiteHeader";
import { StatusStamp } from "../ui/StatusStamp";
import { HomeHero } from "./HomeHero";
import styles from "./HomePage.module.css";

export function HomePage() {
  const report = getReport("gauntlet-usdc-prime");
  if (!report) throw new Error("The illustrative home report is missing.");

  return (
    <>
      <SiteHeader />
      <DataStateBanner />
      <main id="main-content">
        <HomeHero />
        <section className={styles.manifesto}><SectionHeading align="center" eyebrow="The TR4CE rule" title="A return without a trail is only a claim." detail="A deterministic policy converts observations into an explicit verdict. Every conclusion keeps its limits and block context attached." /></section>
        <section className={styles.traceSection}>
          <div className={styles.traceCopy}><p className={styles.eyebrow}>FROM BLOCK TO VERDICT</p><h2>One trace line. No hidden leap.</h2><p>TR4CE separates what the chain observed from what a policy concludes, then preserves the exact provenance required to reproduce both.</p></div>
          <div className={`${styles.trace} specimenFrame`}><svg aria-hidden="true" viewBox="0 0 760 230"><path d="M80 115H220C260 115 272 55 326 55H435C475 55 490 170 540 170H680" /><circle cx="80" cy="115" r="9" /><circle cx="326" cy="55" r="9" /><circle cx="540" cy="170" r="9" /><circle cx="680" cy="170" r="9" /></svg><div className={styles.traceNodes}><span>Block</span><span>Observation</span><span>Calculation</span><span>Verdict</span></div></div>
        </section>
        <section className={styles.specimen}>
          <div className={styles.specimenCopy}><p className={styles.eyebrow}>REPORT SPECIMEN</p><h2>Lead with the verdict. Leave the math intact.</h2><p>The full report stays human-readable and machine-verifiable. It never replaces missing evidence with a clean-looking zero.</p><Link href="/reports/gauntlet-usdc-prime">Inspect the report</Link></div>
          <article className={`${styles.reportCard} specimenFrame`}><header><div><p>Gauntlet USDC Prime</p><code>Base · block 50,879,897</code></div><StatusStamp reason="All five illustrative policy rules passed." status="PASS" /></header><div className={styles.metric}><span>Observed share-value return</span><strong>+0.41%</strong><p>7 days · USDC share conversion</p></div><BlockRuler end="50,879,897" start="50,577,041" /></article>
        </section>
        <section className={styles.outcomes}><SectionHeading align="center" eyebrow="A complete vocabulary" title="PASS, FAIL, and UNKNOWN all carry meaning." /><div className={styles.outcomeGrid}><article><StatusStamp reason="The shown evidence meets every required rule." size="feature" status="PASS" /><h3>Evidence meets the policy.</h3><p>PASS is a policy conclusion at a named block, not a safety or yield promise.</p></article><article><StatusStamp reason="At least one required threshold was not met." size="feature" status="FAIL" /><h3>A named rule did not pass.</h3><p>Failure says what missed the threshold so a reviewer can audit the decision.</p></article><article><StatusStamp reason="Adapter semantics do not support a reliable conclusion." size="feature" status="UNKNOWN" /><h3>Missing certainty stays missing.</h3><p>UNKNOWN blocks a pass. It is evidence of uncertainty, not an empty visual state.</p></article></div></section>
        <section className={styles.actionStage}><div><p className={styles.eyebrow}>WALLET AUTHORITY</p><h2>Preparation is not execution.</h2><p>TR4CE prepares direct calls and binds the simulation to chain, account, calldata, and block. The connected owner still approves every state-changing transaction.</p><Link href="/actions/act_gauntletDeposit01">Review action preview</Link></div><ol><li><span>01</span>Prepared</li><li><span>02</span>Simulated</li><li><span>03</span>Wallet confirmed</li></ol></section>
        <section className={styles.limitation}><LimitationCallout limitations={report.limitations} /></section>
      </main>
      <SiteFooter />
    </>
  );
}
