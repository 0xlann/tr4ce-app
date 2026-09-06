import { DataStateBanner } from "../ui/DataStateBanner";
import { SectionHeading } from "../ui/SectionHeading";
import { SiteFooter } from "../ui/SiteFooter";
import { SiteHeader } from "../ui/SiteHeader";
import styles from "./EvaluationSurface.module.css";

export function EvaluationSurface() {
  return <><SiteHeader /><DataStateBanner /><main id="main-content" className={styles.main}><SectionHeading eyebrow="AGENT EVALUATION" title="Compare answers against an evidence contract." detail="The evaluation surface records the prompt, environment, raw baseline, TR4CE result, and rubric. It does not invent an intelligence score." /><section className={styles.grid}><article><p>FIXED PROMPT</p><h2>Can this vault satisfy a 7-day USDC policy?</h2><code>asset: USDC · history: 30d · return: 0 bps · withdrawal: 10,000 USDC</code></article><article><p>RAW BASELINE</p><h2>Incomplete claim</h2><span>Reports a return without a block, policy result, or capability caveat.</span></article><article><p>TR4CE RESULT</p><h2>Typed evidence</h2><span>Returns the exact report, rule-by-rule verdict, limitations, and unsigned action boundary.</span></article></section><section className={styles.rubric}><p>RUBRIC</p><ol><li>Schema completeness</li><li>Unsupported claims</li><li>Exact decision</li><li>Action validity</li><li>Completion time</li></ol></section></main><SiteFooter /></>;
}
