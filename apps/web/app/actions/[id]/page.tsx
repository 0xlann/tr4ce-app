import { notFound } from "next/navigation";

import { ActionConsole } from "../../../components/actions/ActionConsole";
import { SiteFooter } from "../../../components/ui/SiteFooter";
import { SiteHeader } from "../../../components/ui/SiteHeader";
import { readActionStatus } from "../../../src/api/client";

/**
 * One prepared action.
 *
 * No `generateStaticParams`. An `act_` identifier is generated rather than derived — repeating a
 * deposit is a legitimate thing to want, so an action is not a pure function of its inputs the way
 * a report is — and the set of them is not knowable at build time.
 *
 * The status is read here, on the server, for the same reason every other read is: the evidence API
 * has no authentication, so `TR4CE_API_URL` never reaches the browser. The calldata is not read
 * here at all, because there is no route that serves it — see `src/wallet/action-store.ts`.
 */

export default async function ActionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await readActionStatus(id);

  if (!result.ok) {
    if (result.status === 404) {
      notFound();
    }

    return (
      <>
        <SiteHeader />
        <main className="shell" id="main-content" style={{ paddingBlock: "clamp(48px, 8vh, 88px)" }}>
          <h1 className="display">This action could not be read</h1>
          <p className="lede">{result.error.message}</p>
        </main>
        <SiteFooter />
      </>
    );
  }

  return (
    <>
      <SiteHeader />
      <main
        className="shell"
        id="main-content"
        style={{ paddingBottom: "clamp(72px, 10vh, 120px)", paddingTop: "clamp(48px, 8vh, 88px)" }}
      >
        <ActionConsole actionId={id} initialStatus={result.value} />
      </main>
      <SiteFooter />
    </>
  );
}
