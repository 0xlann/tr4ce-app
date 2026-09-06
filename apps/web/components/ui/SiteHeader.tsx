import Link from "next/link";

import { LogoLockup } from "./LogoLockup";
import styles from "./SiteChrome.module.css";

const routes = [
  ["Evidence", "/search"],
  ["Reports", "/reports/gauntlet-usdc-prime"],
  ["Action", "/actions/act_gauntletDeposit01"],
  ["Evaluation", "/evals"],
] as const;

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <Link aria-label="TR4CE home" href="/"><LogoLockup /></Link>
      <nav className={styles.nav} aria-label="Primary navigation">
        {routes.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
      </nav>
      <Link className={styles.headerAction} href="/search">Explore evidence</Link>
    </header>
  );
}
