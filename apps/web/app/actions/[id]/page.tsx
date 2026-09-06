import { notFound } from "next/navigation";

import { ActionConsole } from "../../../components/actions/ActionConsole";
import { SiteFooter } from "../../../components/ui/SiteFooter";
import { SiteHeader } from "../../../components/ui/SiteHeader";
import { getPreparedAction } from "../../../src/demo/fixtures";

export function generateStaticParams() {
  return [{ id: "act_gauntletDeposit01" }];
}

export default async function ActionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const action = getPreparedAction(id);
  if (!action) notFound();

  return (
    <>
      <SiteHeader />
      <main id="main-content" className="shell" style={{ paddingBottom: "clamp(72px, 10vh, 120px)", paddingTop: "clamp(48px, 8vh, 88px)" }}>
        <ActionConsole action={action} />
      </main>
      <SiteFooter />
    </>
  );
}
