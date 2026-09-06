import styles from "./LimitationCallout.module.css";

type LimitationCalloutProps = { limitations: readonly string[] };

export function LimitationCallout({ limitations }: LimitationCalloutProps) {
  return (
    <aside className={styles.callout}>
      <p className={styles.eyebrow}>What this does not prove</p>
      {limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
    </aside>
  );
}
