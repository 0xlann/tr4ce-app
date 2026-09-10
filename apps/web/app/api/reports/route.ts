import { addressSchema, chainIdSchema } from "@tr4ce/domain";
import { z } from "zod";

import { createReport } from "../../../src/api/client";
import { invalidRequest, readJson, respond } from "../../../src/api/route-helpers";

/**
 * Record an immutable report and hand back its identifier.
 *
 * The first place this app writes anything — `app/api/actions` writes the other. Everything on
 * `/search` up to this point is a question: evaluating a candidate policy stores nothing, and this
 * is where a user says "make that citable".
 *
 * Idempotent by construction: a report's identifier is derived from the observations it cites, so
 * pressing Inspect twice on unchanged evidence returns the same report rather than a second one.
 * `created` tells the two apart, and the API answers 200 rather than 201 when nothing was made.
 */

const requestSchema = z.strictObject({
  chainId: chainIdSchema,
  vaultAddress: addressSchema,
  windowDays: z.number().int().positive().max(365),
  policy: z.unknown(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await readJson(request));

  if (!parsed.success) {
    return invalidRequest(parsed.error, "The report request does not match the schema.");
  }

  const result = await createReport(parsed.data);

  if (!result.ok) {
    return respond(result);
  }

  return Response.json({
    reportId: result.value.report.reportId,
    created: result.value.created,
  });
}
