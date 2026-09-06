import type { ReactNode } from "react";

import styles from "./SectionHeading.module.css";

type SectionHeadingProps = {
  title: ReactNode;
  detail?: ReactNode;
  aside?: ReactNode;
  align?: "start" | "center";
};

export function SectionHeading({ title, detail, aside, align = "start" }: SectionHeadingProps) {
  return (
    <header className={`${styles.heading} ${styles[align]}`}>
      <div className={styles.row}>
        <h1 className={`display ${styles.title}`}>{title}</h1>
        {aside ? <div className={styles.aside}>{aside}</div> : null}
      </div>
      {detail ? <p className={`lede ${styles.detail}`}>{detail}</p> : null}
    </header>
  );
}
