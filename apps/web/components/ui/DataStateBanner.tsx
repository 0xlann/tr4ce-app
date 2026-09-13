import styles from "./DataStateBanner.module.css";

/**
 * What condition the evidence on this page is in.
 *
 * The states and their copy come from DESIGN-SYSTEMS.md section 9. `partial` and `reorged` are not
 * decoration: a report built on observations that were later reorganised is invalid, and saying so
 * is the difference between evidence and a screenshot.
 *
 * `role="status"` maps to `aria-live="polite"`, which is what section 13 asks for here. Blocking
 * errors use `assertive`, and they live beside the control that failed rather than in this banner.
 */

type DataState = "fresh" | "loading" | "refreshing" | "stale" | "partial" | "reorged";

const copy: Record<DataState, string> = {
  fresh: "Evidence current to the block each report names.",
  loading: "Reading evidence.",
  refreshing: "Updating current reads. Historical report remains available.",
  stale: "Current reads exceed the action limit.",
  partial: "Required observations are unavailable.",
  reorged: "The prior block was reorganized. This report is invalid.",
};

export function DataStateBanner({
  state = "fresh",
  detail = null,
}: {
  state?: DataState;
  /** What specifically was missing or refused, when the API said. */
  detail?: string | null;
}) {
  return (
    <p className={`${styles.banner} ${styles[state]}`} role="status">
      <span aria-hidden="true" className={styles.dot} />
      {copy[state]}
      {detail === null ? null : <span className={styles.detail}>{detail}</span>}
    </p>
  );
}
