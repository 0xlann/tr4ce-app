import styles from "./ShareValueChart.module.css";

const points = [1041000, 1042300, 1041800, 1045100, 1047300, 1046800, 1052300];

export function ShareValueChart() {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${index * 50} ${120 - ((point - min) / (max - min)) * 92}`).join(" ");

  return <figure className={styles.chart}><figcaption><span>Observed share-value history</span><small>Illustrative USDC conversion observations</small></figcaption><svg aria-describedby="share-chart-description" role="img" viewBox="0 0 300 140"><path className={styles.grid} d="M0 28H300M0 74H300M0 120H300" /><path className={styles.line} d={path} /><circle cx="0" cy="120" r="5" /><circle cx="300" cy="28" r="5" /></svg><p className="srOnly" id="share-chart-description">Illustrative share-value observations increase from 1.041 to 1.0523 USDC-equivalent base units across seven days.</p><table><caption className="srOnly">Share value observations table</caption><thead><tr>{points.map((_, index) => <th key={index} scope="col">Day {index + 1}</th>)}</tr></thead><tbody><tr>{points.map((point) => <td key={point}>{point}</td>)}</tr></tbody></table></figure>;
}
