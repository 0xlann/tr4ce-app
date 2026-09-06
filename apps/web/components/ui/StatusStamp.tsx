import type { PolicyRuleStatus } from "@tr4ce/domain";

import { statusPresentation } from "./status-presentation";
import styles from "./StatusStamp.module.css";

type StatusStampProps = {
  status: PolicyRuleStatus;
  reason: string;
  size?: "compact" | "feature";
};

export function StatusStamp({ status, reason, size = "compact" }: StatusStampProps) {
  const presentation = statusPresentation(status);

  return (
    <span className={`${styles.stamp} ${styles[status.toLowerCase()]} ${styles[size]}`}>
      <span aria-hidden="true" className={styles.icon}>{presentation.icon}</span>
      <span className={styles.label}>{presentation.label}</span>
      <span className="srOnly">: {reason}</span>
    </span>
  );
}
