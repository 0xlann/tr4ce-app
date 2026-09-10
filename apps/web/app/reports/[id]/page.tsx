import { notFound } from "next/navigation";

import { ReportDossier } from "../../../components/evidence/ReportDossier";
import { DataStateBanner } from "../../../components/ui/DataStateBanner";
import { SiteFooter } from "../../../components/ui/SiteFooter";
import { SiteHeader } from "../../../components/ui/SiteHeader";
import { listVaults, readReport } from "../../../src/api/client";

/**
 * One immutable report, served from the bytes the API stored.
 *
 * No `generateStaticParams`. A report identifier is `trc_` plus a digest of the observations it
 * cites, so the set of them is not knowable at build time — it is whatever anyone has asked for.
 * The page renders dynamically and reads through, which is also what makes a shared report URL work
 * for someone who was not here when it was made.
 */

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await readReport(id);

  if (!result.ok) {
    if (result.status === 404) {
      notFound();
    }

    /*
     * The API is reachable but would not answer for this report. Distinct from "no such report", and
     * shown as a limitation rather than a 404: telling a user their report does not exist when the
     * truth is that we could not read it is the kind of wrong answer this product exists to avoid.
     */
    return (
      <>
        <SiteHeader />
        <DataStateBanner detail={result.error.message} state="partial" />
        <main className="shell" id="main-content" style={{ paddingBlock: "clamp(48px, 8vh, 88px)" }}>
          <h1 className="display">This report could not be read</h1>
          <p className="lede">{result.error.message}</p>
        </main>
        <SiteFooter />
      </>
    );
  }

  const { report } = result.value;

  /*
   * The report's own vault identity carries the addresses, not a human name — `vaultIdentitySchema`
   * is deliberately narrow, because a name is registry metadata rather than evidence. So the name
   * comes from the registry, and the page still renders without it.
   */
  const registry = await listVaults(report.vault.chainId);
  const entry = registry.ok
    ? registry.value.vaults.find(
        (vault) => vault.address.toLowerCase() === report.vault.address.toLowerCase(),
      )
    : undefined;

  return (
    <>
      <SiteHeader />
      <DataStateBanner state={report.policy.status === "UNKNOWN" ? "partial" : "fresh"} />
      <main
        className="shell"
        id="main-content"
        style={{ paddingBottom: "clamp(72px, 10vh, 120px)", paddingTop: "clamp(48px, 8vh, 88px)" }}
      >
        <ReportDossier
          name={entry?.name ?? entry?.symbol ?? report.vault.address}
          protocol={entry?.adapterKey ?? "erc4626"}
          report={report}
        />
      </main>
      <SiteFooter />
    </>
  );
}
