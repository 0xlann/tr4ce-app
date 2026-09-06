import { DataStateBanner } from "../ui/DataStateBanner";
import { SiteFooter } from "../ui/SiteFooter";
import { SiteHeader } from "../ui/SiteHeader";
import styles from "./EvaluationSurface.module.css";

const rubric = [
  ["Schema completeness", "Every required field present and typed."],
  ["Unsupported claims", "No forecast, safety, or yield language."],
  ["Exact decision", "The verdict matches the policy output."],
  ["Action validity", "Unsigned call matches the prepared action."],
  ["Completion time", "Latency budget for hosted serving."],
] as const;

export function EvaluationSurface() {
  return (
    <>
      <SiteHeader />
      <DataStateBanner />
      <main id="main-content" className={styles.main}>
        <header className={styles.lead}>
          <h1 className={`display ${styles.leadTitle}`} data-reveal>
            Compare answers against an <em className="serifAccent">evidence contract.</em>
          </h1>
          <p className="lede" data-reveal data-reveal-delay="0.1">
            The evaluation surface records the prompt, environment, raw baseline, TR4CE result, and
            rubric. It does not invent an intelligence score.
          </p>
        </header>

        <section className={`blackPanel ${styles.prompt}`} data-reveal>
          <p className={styles.promptLabel}>Fixed prompt</p>
          <p className={styles.promptText}>
            Can this vault satisfy a 7-day USDC policy?
          </p>
          <code className={styles.promptEnv}>asset: USDC · history: 30d · return: 0 bps · withdrawal: 10,000 USDC</code>
        </section>

        <section aria-label="Baseline comparison" className={styles.compare}>
          <article className={styles.baseline} data-reveal>
            <p className={styles.cardLabel}>Raw baseline</p>
            <h2>Incomplete claim</h2>
            <p>
              Reports a return without a block, policy result, or capability caveat. A reviewer must
              take the number on faith.
            </p>
          </article>
          <span aria-hidden="true" className={styles.compareArrow} data-reveal data-reveal-delay="0.12">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 16 16">
              <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
            </svg>
          </span>
          <article className={styles.result} data-reveal data-reveal-delay="0.18">
            <p className={styles.cardLabel}>TR4CE result</p>
            <h2>Typed evidence</h2>
            <p>
              Returns the exact report, rule-by-rule verdict, limitations, and unsigned action
              boundary — reproducible at the named block.
            </p>
          </article>
        </section>

        <section aria-label="Rubric" className={styles.rubric}>
          <div className={styles.rubricLead}>
            <h2 className="display">The rubric is <em className="serifAccent">public.</em></h2>
          </div>
          <ol className={styles.rubricList}>
            {rubric.map(([title, detail], index) => (
              <li data-reveal data-reveal-delay={String(index * 0.05)} key={title}>
                <span className={styles.rubricIndex}>{`0${index + 1}`}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
