import { addressSchema, chainIdSchema } from "@tr4ce/domain";
import { z } from "zod";

import { createReport } from "../../../src/api/client";

/**
 * Record an immutable report and hand back its identifier.
 *
 * The one place this app writes anything. Everything on `/search` up to this point is a question —
 * evaluating a candidate policy stores nothing — and this is where a user says "make that citable".
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
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "The report request does not match the schema.",
          reasonCodes: [],
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  const result = await createReport(parsed.data);

  if (!result.ok) {
    // Passed through rather than translated. The API already words its refusals for a person, and
    // rewording them here would put a second vocabulary in front of the same failure.
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    reportId: result.value.report.reportId,
    created: result.value.created,
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
