import { evaluatePolicy } from "../../../src/api/client";
import {
  evaluationOutcomeSchema,
  evaluationRequestSchema,
  evaluationResponseSchema,
} from "../../../src/api/evaluation";

/**
 * Evaluate one draft policy against several vaults, from the server.
 *
 * The browser talks to this route rather than to the evidence API. The API mounts no CORS
 * middleware and, more to the point, no authentication: reaching it from the browser would mean
 * reaching it from anyone. `TR4CE_API_URL` therefore never leaves the server.
 *
 * One request rather than one per vault. Each evaluation costs the API a set of chain reads, and a
 * policy panel that fired four independent requests on every keystroke would be both slower and
 * harder to show a single honest loading state for.
 *
 * Nothing is stored. `POST /v1/policies/evaluate` is explicit that evaluating a candidate policy is
 * a question rather than a claim (TR-F-024), and this route inherits that.
 */

export async function POST(request: Request): Promise<Response> {
  const parsed = evaluationRequestSchema.safeParse(await readJson(request));

  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "The evaluation request does not match the schema.",
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

  const { chainId, vaultAddresses, windowDays, policy } = parsed.data;

  /*
   * In parallel, and one vault's failure does not sink the others.
   *
   * A vault whose observations are incomplete is a normal outcome here — it is the UNKNOWN case the
   * whole product exists to show. Letting it reject the batch would hide exactly the result a user
   * most needs to see.
   */
  const outcomes = await Promise.all(
    vaultAddresses.map(async (vaultAddress) => {
      const result = await evaluatePolicy({ chainId, vaultAddress, windowDays, policy });

      if (!result.ok) {
        return evaluationOutcomeSchema.parse({
          vaultAddress,
          status: null,
          asOfBlock: null,
          rules: null,
          issues: [...result.error.issues],
          unavailable: result.error.message,
        });
      }

      const { evaluation, issues, asOfBlock } = result.value;

      return evaluationOutcomeSchema.parse({
        vaultAddress,
        status: evaluation?.status ?? null,
        asOfBlock,
        rules:
          evaluation?.rules.map((rule) => ({
            key: rule.key,
            status: rule.status,
            threshold: rule.threshold,
            observedValue: rule.observedValue,
            reasonCodes: [...rule.reasonCodes],
          })) ?? null,
        issues: [...issues],
        unavailable: null,
      });
    }),
  );

  // Parsed on the way out as well: the panel parses what it receives, and a response the two ends
  // disagree about should fail here rather than half-render there.
  return Response.json(evaluationResponseSchema.parse({ schemaVersion: "1.0.0", outcomes }));
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
