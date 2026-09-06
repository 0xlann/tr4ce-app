import styles from "./BlockRuler.module.css";

type BlockRulerProps = {
  start: string;
  end: string;
  label?: string;
};

export function BlockRuler({ start, end, label = "Observed window" }: BlockRulerProps) {
  return (
    <div className={styles.ruler} aria-label={`${label}: block ${start} to block ${end}`}>
      <span className={styles.label}>{label}</span>
      <svg aria-hidden="true" className={styles.ticks} viewBox="0 0 220 20" preserveAspectRatio="none">
        {Array.from({ length: 17 }, (_, index) => <path key={index} d={`M ${index * 13.75} ${index % 4 === 0 ? 2 : 8}v ${index % 4 === 0 ? 16 : 10}`} />)}
      </svg>
      <div className={styles.blocks}><span>{start}</span><span>{end}</span></div>
    </div>
  );
}
