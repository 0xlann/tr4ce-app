import Link from "next/link";

import { LogoLockup } from "./LogoLockup";
import styles from "./SiteChrome.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div><LogoLockup /><p>Verifiable vault evidence. No custody. No guarantees.</p></div>
      <div className={styles.footerLinks}>
        <Link href="/search">Search evidence</Link>
        <Link href="/evals">Evaluation</Link>
        <a href="https://eips.ethereum.org/EIPS/eip-4626" rel="noreferrer" target="_blank">ERC-4626 standard</a>
      </div>
      <p className={styles.footerNote}>Illustrative interface. Values shown here are not live provider output.</p>
    </footer>
  );
}
