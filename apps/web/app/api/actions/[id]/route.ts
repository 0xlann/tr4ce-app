import { readActionStatus } from "../../../../src/api/client";
import { respond } from "../../../../src/api/route-helpers";

/**
 * Where a prepared action stands, judged against the chain now.
 *
 * Status only — no calldata. The API answers this from the row plus a fresh look at the binding,
 * and `actionStatusResponseSchema` carries no `transactions` field, so a browser that did not
 * prepare this action cannot recover the bytes from here.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  return respond(await readActionStatus(id));
}
