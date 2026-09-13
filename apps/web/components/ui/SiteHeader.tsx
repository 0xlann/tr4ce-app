"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { LogoLockup } from "./LogoLockup";
import styles from "./SiteChrome.module.css";

const routes = [
  ["Evidence", "/search"],
  ["Reports", "/reports/gauntlet-usdc-prime"],
  ["Action", "/actions/act_gauntletDeposit01"],
  ["Evaluation", "/evals"],
] as const;

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <div className={styles.headerDock}>
      <header className={styles.header}>
        <Link aria-label="TR4CE home" className={styles.brand} href="/">
          <LogoLockup />
        </Link>
        <nav aria-label="Primary navigation" className={styles.nav}>
          {routes.map(([label, href]) => {
            const section = `/${href.split("/")[1]}`;
            const active = pathname === href || pathname.startsWith(`${section}/`) || pathname === section;
            return (
              <Link aria-current={active ? "page" : undefined} className={active ? styles.navActive : undefined} key={href} href={href}>
                {label}
              </Link>
            );
          })}
        </nav>
        <Link className={`${styles.headerAction} pill pillGreen pillSmall`} href="/search">
          Explore evidence
        </Link>
      </header>
    </div>
  );
}
