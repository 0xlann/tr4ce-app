"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import Link from "next/link";
import { useReducer, useRef } from "react";

import { getPolicyPreset, getVaultSummaries } from "../../src/demo/fixtures";
import { formatUsdcMillions } from "../../src/demo/display";
import { BlockRuler } from "../ui/BlockRuler";
import { StatusStamp } from "../ui/StatusStamp";
import { initialHeroState, reduceHeroState } from "./hero-state";
import styles from "./HomeHero.module.css";

gsap.registerPlugin(useGSAP);

const presets = ["strict", "balanced", "lenient"] as const;

export function HomeHero() {
  const [state, dispatch] = useReducer(reduceHeroState, initialHeroState);
  const root = useRef<HTMLElement>(null);
  const policy = getPolicyPreset(state.preset);
  const vaults = getVaultSummaries(state.preset);

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from("[data-hero-word]", { autoAlpha: 0, y: 28, duration: 0.56, ease: "power3.out", stagger: 0.07 });
    gsap.from("[data-hero-instrument]", { autoAlpha: 0, y: 24, duration: 0.64, delay: 0.18, ease: "power3.out" });
  }, { scope: root });

  return (
    <section ref={root} className={styles.hero}>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>ERC-4626 evidence instrument</p>
        <h1><span data-hero-word>Read the vault.</span><span data-hero-word>Trace the block.</span><span data-hero-word>Keep the authority.</span></h1>
        <p className={styles.detail}>TR4CE turns vault observations into a typed policy verdict with visible limitations, reproducible blocks, and no custody.</p>
        <div className={styles.ctas}><Link className={styles.primary} href="/search">Explore evidence</Link><Link className={styles.secondary} href="/reports/gauntlet-usdc-prime">Open report specimen</Link></div>
        <p className={styles.note}>Illustrative evidence fixture. No wallet or live provider is connected.</p>
      </div>

      <aside data-hero-instrument className={`${styles.instrument} specimenFrame`} aria-label="Illustrative policy results">
        <div className={styles.instrumentHeader}><div><p>POLICY PRESET</p><h2>{state.preset}</h2></div><span>v{policy.version}</span></div>
        <div className={styles.presets} aria-label="Policy preset">
          {presets.map((preset) => <button aria-pressed={state.preset === preset} className={state.preset === preset ? styles.activePreset : ""} key={preset} onClick={() => dispatch({ type: "SELECT_PRESET", preset })} type="button">{preset}</button>)}
        </div>
        <dl className={styles.rules}><div><dt>Asset</dt><dd>USDC</dd></div><div><dt>History</dt><dd>{policy.minHistoryDays} days</dd></div><div><dt>TVL</dt><dd>{formatUsdcMillions(policy.minTvlAssets)}</dd></div><div><dt>Window</dt><dd>{policy.minObservedReturnBps.windowDays} days</dd></div></dl>
        <div className={styles.outcomes} aria-live="polite">
          {vaults.map((vault) => <article key={vault.id} className={styles.outcome}><div><strong>{vault.name}</strong><span>{vault.completeness}% complete</span></div><StatusStamp reason={vault.report.policy.rules.find((rule) => rule.status !== "PASS")?.reasonCodes[0] ?? "All five rules passed."} status={vault.report.policy.status} /></article>)}
        </div>
        <BlockRuler end="50,879,897" label="Illustrative block context" start="50,577,041" />
      </aside>
    </section>
  );
}
