import styles from "./LogoLockup.module.css";

type LogoLockupProps = {
  compact?: boolean;
  className?: string;
};

export function LogoLockup({ compact = false, className }: LogoLockupProps) {
  const rootClassName = [styles.lockup, compact ? styles.compact : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={rootClassName}>
      <img
        className={styles.icon}
        src="/icon-logo.png"
        alt={compact ? "TR4CE" : ""}
        aria-hidden={compact ? undefined : true}
      />
      {!compact ? <img className={styles.wordmark} src="/text-logo.png" alt="TR4CE" /> : null}
    </span>
  );
}
