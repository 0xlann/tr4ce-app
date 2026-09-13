import styles from "./LimitationCallout.module.css";

type LimitationCalloutProps = { limitations: readonly string[] };

export function LimitationCallout({ limitations }: LimitationCalloutProps) {
  return (
    <aside className={styles.callout}>
      <div className={styles.head}>
        <h2 className={styles.title}>What this <em className="serifAccent">does not</em> prove</h2>
        <span className="monoLabel">Read before acting</span>
      </div>
      {limitations.map((limitation) => <p className={styles.item} key={limitation}>{limitation}</p>)}
    </aside>
  );
}
