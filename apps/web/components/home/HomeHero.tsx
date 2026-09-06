"use client";

import { useReducer } from "react";

import { getPolicyPreset, getVaultSummaries } from "../../src/demo/fixtures";
import { formatUsdcMillions } from "../../src/demo/display";
import { BlockRuler } from "../ui/BlockRuler";
import { ScribbleRing, ScribbleUnderline } from "../ui/Scribbles";
import { StatusStamp } from "../ui/StatusStamp";
import { initialHeroState, reduceHeroState } from "./hero-state";
import styles from "./HomeHero.module.css";

const presets = ["strict", "balanced", "lenient"] as const;

export function HomeHero() {
  const [state, dispatch] = useReducer(reduceHeroState, initialHeroState);
  const policy = getPolicyPreset(state.preset);
  const vaults = getVaultSummaries(state.preset);

  return (
    <section aria-label="TR4CE evidence instrument" className={styles.hero}>
      <div className={`shell ${styles.grid}`}>
        <div className={styles.copy}>
          <h1 className={styles.headline}>
            <span data-reveal className={styles.line}>Every vault claim,</span>
            <span data-reveal data-reveal-delay="0.12" className={styles.line}>
              <em className={styles.accent}>on the record.</em>
            </span>
          </h1>
          <div className={styles.underlineWrap} aria-hidden="true">
            <span className={styles.underline}><ScribbleUnderline size={340} /></span>
          </div>
          <p className={`lede ${styles.lede}`} data-reveal data-reveal-delay="0.24">
            TR4CE turns vault observations into a typed policy verdict — with visible limitations,
            reproducible blocks, and no custody.
          </p>
          <div className={styles.ctas} data-reveal data-reveal-delay="0.34">
            <a className="pill pillGreen" href="/search">Explore the evidence</a>
            <a className="pill pillGhost" href="/reports/gauntlet-usdc-prime">Open a report specimen</a>
          </div>
          <p className={`monoLabel ${styles.note}`} data-reveal data-reveal-delay="0.42">
            Illustrative fixture — no wallet or live provider is connected.
          </p>
        </div>

        <aside aria-label="Illustrative policy results" className={styles.instrumentWrap} data-reveal data-reveal-delay="0.2">
          <span aria-hidden="true" className={styles.ring}><ScribbleRing size={132} /></span>
          <div className={`periPanel ${styles.instrument}`}>
            <div className={styles.instrumentHead}>
              <div>
                <p className="monoLabel">Policy preset</p>
                <p className={styles.presetName}>{state.preset}</p>
              </div>
              <span className={styles.version}>v{policy.version}</span>
            </div>

            <div aria-label="Policy preset" className={styles.presets} role="group">
              {presets.map((preset) => (
                <button
                  aria-pressed={state.preset === preset}
                  className={state.preset === preset ? styles.activePreset : styles.preset}
                  key={preset}
                  onClick={() => dispatch({ type: "SELECT_PRESET", preset })}
                  type="button"
                >
                  {preset}
                </button>
              ))}
            </div>

            <dl className={styles.rules}>
              <div><dt>Asset</dt><dd>USDC</dd></div>
              <div><dt>History</dt><dd className="num">{policy.minHistoryDays} days</dd></div>
              <div><dt>TVL floor</dt><dd className="num">{formatUsdcMillions(policy.minTvlAssets)}</dd></div>
              <div><dt>Window</dt><dd className="num">{policy.minObservedReturnBps.windowDays} days</dd></div>
            </dl>

            <div aria-live="polite" className={styles.outcomes}>
              {vaults.map((vault) => (
                <article className={styles.outcome} key={`${state.preset}-${vault.id}`}>
                  <div className={styles.outcomeCopy}>
                    <strong>{vault.name}</strong>
                    <span className="num">{vault.completeness}% complete</span>
                  </div>
                  <StatusStamp
                    reason={vault.report.policy.rules.find((rule) => rule.status !== "PASS")?.reasonCodes[0] ?? "All five rules passed."}
                    status={vault.report.policy.status}
                  />
                </article>
              ))}
            </div>

            <BlockRuler end="50,879,897" label="Illustrative block context" start="50,577,041" />
          </div>
        </aside>
      </div>
    </section>
  );
}
