import styles from "./SectionHeading.module.css";

type SectionHeadingProps = {
  eyebrow: string;
  title: string;
  detail?: string;
  align?: "start" | "center";
};

export function SectionHeading({ eyebrow, title, detail, align = "start" }: SectionHeadingProps) {
  return (
    <header className={`${styles.heading} ${styles[align]}`}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
    </header>
  );
}
