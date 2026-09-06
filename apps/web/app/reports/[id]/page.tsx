import { notFound } from "next/navigation";

import { ReportDossier } from "../../../components/evidence/ReportDossier";
import { DataStateBanner } from "../../../components/ui/DataStateBanner";
import { SiteFooter } from "../../../components/ui/SiteFooter";
import { SiteHeader } from "../../../components/ui/SiteHeader";
import { getVaultSummaries } from "../../../src/demo/fixtures";

export function generateStaticParams() {
  return getVaultSummaries("balanced").map((vault) => ({ id: vault.id }));
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const vault = getVaultSummaries("balanced").find((item) => item.id === id);
  if (!vault) notFound();

  return (
    <>
      <SiteHeader />
      <DataStateBanner />
      <main id="main-content" style={{ margin: "0 auto", maxWidth: 1020, padding: "72px 20px 112px" }}>
        <ReportDossier name={vault.name} protocol={vault.protocol} report={vault.report} />
      </main>
      <SiteFooter />
    </>
  );
}
