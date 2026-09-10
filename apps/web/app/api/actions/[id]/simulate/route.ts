import { simulateAction } from "../../../../../src/api/client";
import { respond } from "../../../../../src/api/route-helpers";

/**
 * Resimulate the next unsent call against the current block.
 *
 * Two things reach this route. An action whose binding moved stops being signable "until
 * resimulation", and this is that resimulation. And the deposit half of an approve-plus-deposit
 * pair has no simulation of its own until the approval has landed — before that it would revert, so
 * the API reports `NOT_SIMULATED` rather than claiming a failure nobody established.
 */

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  return respond(await simulateAction(id));
}
