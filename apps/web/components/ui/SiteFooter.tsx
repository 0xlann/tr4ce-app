import Link from "next/link";

import { LogoLockup } from "./LogoLockup";
import styles from "./SiteChrome.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footerDock}>
      <div className={styles.footer}>
        <div className={styles.footerBrand}>
          <LogoLockup onDark />
          <p>
            Verifiable vault evidence. Observations pinned to blocks, verdicts typed by policy, and
            every limitation kept attached. No custody. No guarantees.
          </p>
          <p className={styles.footerNote}>Illustrative interface. Values shown are not live provider output.</p>
        </div>
        <nav aria-label="Footer" className={styles.footerLinks}>
          <p className="monoLabel">Surface</p>
          <Link href="/search">Search evidence</Link>
          <Link href="/reports/gauntlet-usdc-prime">Report specimen</Link>
          <Link href="/actions/act_gauntletDeposit01">Action preview</Link>
          <Link href="/evals">Agent evaluation</Link>
        </nav>
        <div className={styles.footerLinks}>
          <p className="monoLabel">Standard</p>
          <a href="https://eips.ethereum.org/EIPS/eip-4626" rel="noreferrer" target="_blank">ERC-4626</a>
          <a href="https://docs.base.org/" rel="noreferrer" target="_blank">Base network</a>
          <a href="https://github.com/0xlann/tr4ce-app" rel="noreferrer" target="_blank">Source</a>
        </div>
        <p aria-hidden="true" className={styles.footerStamp}>TR4CE · ON THE RECORD</p>
      </div>
    </footer>
  );
}
