import type { PolicyRuleStatus } from "@tr4ce/domain";

import { statusPresentation } from "./status-presentation";
import styles from "./StatusStamp.module.css";

type StatusStampProps = {
  status: PolicyRuleStatus;
  reason: string;
  size?: "compact" | "feature";
};

function StatusGlyph({ status }: { status: PolicyRuleStatus }) {
  if (status === "PASS") {
    return (
      <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" viewBox="0 0 16 16">
        <path d="M2.5 8.6 6.2 12.4 13.5 4" />
      </svg>
    );
  }
  if (status === "FAIL") {
    return (
      <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" viewBox="0 0 16 16">
        <path d="M3.5 3.5 12.5 12.5 M12.5 3.5 3.5 12.5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" viewBox="0 0 16 16">
      <path d="M5.6 5.4a2.5 2.5 0 1 1 3.4 2.9c-.8.4-1 .9-1 1.9" />
      <path d="M8 12.9h.01" />
    </svg>
  );
}

export function StatusStamp({ status, reason, size = "compact" }: StatusStampProps) {
  const presentation = statusPresentation(status);

  return (
    <span className={`${styles.stamp} ${styles[status.toLowerCase()]} ${styles[size]}`}>
      <span aria-hidden="true" className={styles.icon}><StatusGlyph status={status} /></span>
      <span className={styles.label}>{presentation.label}</span>
      <span className="srOnly">: {reason}</span>
    </span>
  );
}
