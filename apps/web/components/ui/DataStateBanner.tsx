import styles from "./DataStateBanner.module.css";

type DataState = "fresh" | "refreshing" | "stale" | "partial" | "reorged";

const copy: Record<DataState, string> = {
  fresh: "Illustrative evidence current to the shown block.",
  refreshing: "Updating current reads. Historical report remains available.",
  stale: "Current reads exceed the action limit.",
  partial: "Required observations are unavailable.",
  reorged: "The prior block was reorganized. This report is invalid.",
};

export function DataStateBanner({ state = "fresh" }: { state?: DataState }) {
  return (
    <p className={`${styles.banner} ${styles[state]}`} role="status">
      <span aria-hidden="true" className={styles.dot} />
      {copy[state]}
    </p>
  );
}
