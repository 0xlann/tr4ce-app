import { reportSubmissionRequestSchema } from "@tr4ce/domain";

import { reportSubmission } from "../../../../../src/api/client";
import { invalidRequest, readJson, respond } from "../../../../../src/api/route-helpers";

/**
 * Report a transaction hash the caller's wallet already produced.
 *
 * The only way a hash enters TR4CE, and it enters as a report about something that has already
 * happened somewhere else (PRD TR-F-043). Nothing here signs or submits.
 *
 * The API looks for the receipt once. A hash reported before it is mined stores nothing and leaves
 * the action `submitted`, so moving on to `confirmed` or `reverted` means reporting the same hash
 * again later — not polling `GET /v1/actions/:id`, which never looks at a receipt.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const parsed = reportSubmissionRequestSchema.safeParse(await readJson(request));

  if (!parsed.success) {
    return invalidRequest(parsed.error, "The submission report does not match the schema.");
  }

  return respond(await reportSubmission(id, parsed.data));
}
