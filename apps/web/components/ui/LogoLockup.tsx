import styles from "./LogoLockup.module.css";

type LogoLockupProps = {
  compact?: boolean;
  className?: string;
  /** Renders the mark inside a cream chip so it survives dark surfaces. */
  onDark?: boolean;
};

export function LogoLockup({ compact = false, className, onDark = false }: LogoLockupProps) {
  const rootClassName = [
    styles.lockup,
    compact ? styles.compact : "",
    onDark ? styles.onDark : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={rootClassName}>
      <img
        className={styles.icon}
        src="/icon-logo-t.png"
        alt={compact ? "TR4CE" : ""}
        aria-hidden={compact ? undefined : true}
        width={34}
        height={34}
      />
      {!compact ? <img className={styles.wordmark} src="/text-logo-t.png" alt="TR4CE" height={16} /> : null}
    </span>
  );
}
