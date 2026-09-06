import Link from "next/link";

import { getReport } from "../../src/demo/fixtures";
import { BlockRuler } from "../ui/BlockRuler";
import { DataStateBanner } from "../ui/DataStateBanner";
import { LimitationCallout } from "../ui/LimitationCallout";
import { ScribbleRing } from "../ui/Scribbles";
import { SiteFooter } from "../ui/SiteFooter";
import { SiteHeader } from "../ui/SiteHeader";
import { StatusStamp } from "../ui/StatusStamp";
import { HomeHero } from "./HomeHero";
import styles from "./HomePage.module.css";

const tickerItems = [
  "BASE",
  "BLOCK 50,879,897",
  "ERC-4626",
  "USDC",
  "POLICY v1",
  "PASS / FAIL / UNKNOWN",
  "NO CUSTODY",
  "OBSERVED — NOT PROMISED",
];

const pairs = [
  { before: "Opaque", after: "On the record" },
  { before: "Claimed", after: "Block-pinned" },
  { before: "Manual", after: "Reproducible" },
  { before: "Assumed", after: "Typed" },
];

export function HomePage() {
  const report = getReport("gauntlet-usdc-prime");
  if (!report) throw new Error("The illustrative home report is missing.");

  return (
    <>
      <SiteHeader />
      <DataStateBanner />
      <main id="main-content">
        <HomeHero />

        <div aria-hidden="true" className={styles.ticker}>
          <div className={styles.tickerTrack}>
            {[0, 1].map((copy) => (
              <div className={styles.tickerRun} key={copy}>
                {tickerItems.map((item) => <span key={item}>{item}<i>✦</i></span>)}
              </div>
            ))}
          </div>
        </div>

        {/* ---- Trace line ---- */}
        <section className={`shell ${styles.trace}`}>
          <div className={styles.traceCopy}>
            <h2 className="display" data-reveal>
              One trace line. <em className="serifAccent">No hidden leap.</em>
            </h2>
            <p className="lede" data-reveal data-reveal-delay="0.1">
              TR4CE separates what the chain <strong>observed</strong> from what a policy
              <strong> concludes</strong>, then preserves the exact provenance required to reproduce both.
            </p>
          </div>
          <div className={styles.traceDiagram} data-draw data-reveal>
            <svg aria-hidden="true" className={styles.traceSvg} viewBox="0 0 920 210">
              <path
                className={`drawLine ${styles.tracePath}`}
                d="M60 150 H240 C305 150 305 62 370 62 H520 C585 62 585 168 650 168 H860"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.8"
                style={{ ["--dash" as string]: 1100 }}
              />
              {[
                { cx: 60, cy: 150 },
                { cx: 370, cy: 62 },
                { cx: 650, cy: 168 },
                { cx: 860, cy: 168 },
              ].map((node, index) => (
                <g key={node.cx}>
                  <circle className={styles.traceNode} cx={node.cx} cy={node.cy} r="7" />
                  <circle className={styles.traceHalo} cx={node.cx} cy={node.cy} r="13" />
                  <text className={styles.traceIndex} textAnchor="middle" x={node.cx} y={node.cy - 22}>{`0${index + 1}`}</text>
                </g>
              ))}
            </svg>
            <div className={styles.traceNodes}>
              <span>Block</span>
              <span>Observation</span>
              <span>Calculation</span>
              <span>Verdict</span>
            </div>
          </div>
        </section>

        {/* ---- Specimen report ---- */}
        <section className={`shell ${styles.specimen}`}>
          <div className={styles.specimenCopy}>
            <h2 className="display" data-reveal>
              Lead with the verdict. <em className="serifAccent">Leave the math intact.</em>
            </h2>
            <p className="lede" data-reveal data-reveal-delay="0.1">
              The full report stays human-readable and machine-verifiable. It never replaces missing
              evidence with a clean-looking zero.
            </p>
            <div data-reveal data-reveal-delay="0.18">
              <Link className="pill pillGhost" href="/reports/gauntlet-usdc-prime">Inspect the report</Link>
            </div>
          </div>
          <article className={`cardPanel ${styles.reportCard}`} data-reveal data-reveal-delay="0.12">
            <header className={styles.reportHead}>
              <div>
                <p className={styles.reportName}>Gauntlet USDC Prime</p>
                <p className="monoLabel">Base · block <span className="num">50,879,897</span></p>
              </div>
              <StatusStamp reason="All five illustrative policy rules passed." size="feature" status="PASS" />
            </header>
            <div className={styles.metric}>
              <span className="monoLabel">Observed share-value return</span>
              <strong className={`num ${styles.metricValue}`}>+0.41%</strong>
              <p className={styles.metricMeta}>7 days · USDC share conversion · not a forecast</p>
            </div>
            <BlockRuler end="50,879,897" start="50,577,041" />
          </article>
        </section>

        {/* ---- Verdict vocabulary ---- */}
        <section className={`shell ${styles.vocabulary}`}>
          <h2 className={`display ${styles.vocabTitle}`} data-reveal>
            Three verdicts. <em className="serifAccent">All of them honest.</em>
          </h2>
          <div className={styles.vocabGrid}>
            <article className={styles.vocabItem} data-reveal>
              <StatusStamp reason="The shown evidence meets every required rule." size="feature" status="PASS" />
              <h3>Evidence meets the policy.</h3>
              <p>PASS is a policy conclusion at a named block — not a safety or yield promise.</p>
            </article>
            <article className={styles.vocabItem} data-reveal data-reveal-delay="0.08">
              <StatusStamp reason="At least one required threshold was not met." size="feature" status="FAIL" />
              <h3>A named rule did not pass.</h3>
              <p>Failure says which threshold missed, so a reviewer can audit the decision.</p>
            </article>
            <article className={styles.vocabItem} data-reveal data-reveal-delay="0.16">
              <StatusStamp reason="Adapter semantics do not support a reliable conclusion." size="feature" status="UNKNOWN" />
              <h3>Missing certainty stays missing.</h3>
              <p>UNKNOWN blocks a pass. It is evidence of uncertainty, not an empty visual state.</p>
            </article>
          </div>
        </section>

        {/* ---- Before / after grid ---- */}
        <section className={`shell ${styles.pairs}`}>
          <div className={styles.pairGrid}>
            {pairs.map((pair, index) => (
              <article className={`periPanel ${styles.pairCard}`} data-reveal data-reveal-delay={String(index * 0.06)} key={pair.before}>
                <p className={styles.pairBefore}>{pair.before}</p>
                <span aria-hidden="true" className={styles.pairArrow}>
                  <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 16 16">
                    <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
                  </svg>
                </span>
                <p className={styles.pairAfter}>{pair.after}</p>
              </article>
            ))}
            <article className={styles.tallCard} data-reveal data-reveal-delay="0.1">
              <span aria-hidden="true" className={styles.tallRing}><ScribbleRing size={110} /></span>
              <p className={styles.tallBefore}>Hope</p>
              <span aria-hidden="true" className={styles.pairArrow}>
                <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 16 16">
                  <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" />
                </svg>
              </span>
              <p className={styles.tallAfter}>Evidence</p>
              <p className={styles.tallCopy}>
                A treasury should not run on hope. TR4CE shows what a vault actually did — at a block
                anyone can re-check.
              </p>
            </article>
          </div>
        </section>

        {/* ---- Manifesto ---- */}
        <section className={`shell ${styles.manifesto}`}>
          <div className={`blackPanel ${styles.manifestoPanel}`} data-draw>
            <span aria-hidden="true" className={styles.manifestoRing}><ScribbleRing size={150} /></span>
            <p className={styles.manifestoLine} data-reveal>
              “A return <em className="serifAccent">without a trail</em> is only a claim.”
            </p>
            <p className={styles.manifestoCopy} data-reveal data-reveal-delay="0.12">
              Every conclusion keeps its limits and block context attached — because evidence you
              cannot reproduce is marketing.
            </p>
            <div className={styles.manifestoFacts} data-reveal data-reveal-delay="0.2">
              <div><strong className="num">5</strong><span>typed rules, one policy</span></div>
              <div><strong className="num">2</strong><span>block-pinned snapshots per window</span></div>
              <div><strong className="num">0</strong><span>transactions TR4CE can sign for you</span></div>
            </div>
          </div>
        </section>

        {/* ---- Wallet authority ---- */}
        <section className={`shell ${styles.action}`}>
          <div className={styles.actionCopy}>
            <h2 className="display" data-reveal>
              Preparation is <em className="serifAccent">not execution.</em>
            </h2>
            <p className="lede" data-reveal data-reveal-delay="0.1">
              TR4CE prepares direct calls and binds the simulation to chain, account, calldata, and
              block. The connected owner still approves every state-changing transaction.
            </p>
            <div data-reveal data-reveal-delay="0.18">
              <Link className="pill pillGreen" href="/actions/act_gauntletDeposit01">Review an action preview</Link>
            </div>
          </div>
          <ol className={styles.actionSteps} data-reveal data-reveal-delay="0.14">
            <li><span>01</span>Prepared</li>
            <li><span>02</span>Simulated</li>
            <li><span>03</span>Wallet confirmed</li>
          </ol>
        </section>

        <section className={`shell ${styles.limitation}`}>
          <LimitationCallout limitations={report.limitations} />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
