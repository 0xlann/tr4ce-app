import type { z } from "zod";

import type { Result } from "./client";

/**
 * The shapes every route handler under `app/api` shares.
 *
 * These handlers exist because the evidence API has no authentication: reaching it from the browser
 * would mean reaching it from anyone. So the browser talks to same-origin routes, and each one
 * validates what it was given before spending a call on the API behind it.
 */

/** A request body that did not match its schema, worded the way the API words its own refusals. */
export function invalidRequest(error: z.ZodError, message: string): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_REQUEST",
        message,
        reasonCodes: [],
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    },
    { status: 400 },
  );
}

/**
 * Hand a `Result` back to the browser.
 *
 * A refusal is passed through rather than translated. The API already words its failures for a
 * person, and rewording them here would put a second vocabulary in front of the same problem.
 */
export function respond<T>(result: Result<T>): Response {
  return result.ok
    ? Response.json(result.value)
    : Response.json({ error: result.error }, { status: result.status });
}

/** `null` rather than a throw, so a malformed body reaches the schema as a value it can refuse. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
