import {
  actionStatusResponseSchema,
  apiErrorSchema,
  evaluatePolicyResponseSchema,
  reportResponseSchema,
  vaultListResponseSchema,
  type ApiError,
} from "@tr4ce/domain";
import type { z } from "zod";

/**
 * Reading the evidence API.
 *
 * Server-side only. Every call goes out from the server — a page, or one of the route
 * handlers under `app/api` — and never from the browser. Two reasons, and the second is the one
 * that matters:
 *
 * The API mounts no CORS middleware, so a browser call would fail its preflight. But it also has no
 * authentication at all. Making it reachable from the browser means making it reachable from
 * anyone, and every visitor could then write reports and prepared actions into the database. Keeping
 * `TR4CE_API_URL` server-side is what keeps the API private.
 *
 * Every response is parsed through the same schema the API parsed it out through. A response that no
 * longer satisfies the published contract fails here, loudly, rather than being rendered as though
 * it did.
 */

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: ApiError["error"] };

/**
 * Where the API lives, from the server's environment.
 *
 * Not `NEXT_PUBLIC_`: that prefix inlines a value into the browser bundle, which is exactly what
 * must not happen to this one.
 */
function baseUrl(): string {
  return process.env["TR4CE_API_URL"] ?? "http://localhost:8787";
}

export async function listVaults(chainId: number): Promise<Result<VaultList>> {
  return request(`/v1/vaults?chainId=${chainId}`, vaultListResponseSchema);
}

export async function readReport(reportId: string): Promise<Result<ReportResponse>> {
  return request(`/v1/reports/${encodeURIComponent(reportId)}`, reportResponseSchema);
}

export async function createReport(body: unknown): Promise<Result<ReportResponse>> {
  return request("/v1/reports", reportResponseSchema, body);
}

/**
 * Evaluate a candidate policy.
 *
 * `422` is an answer here, not a failure. The route returns the ordinary response shape carrying
 * `issues` when the draft does not validate — deliberately, because this endpoint exists so a user
 * can be shown what is wrong with a draft before it is stored (TR-F-024). Treating the status code
 * alone as the verdict discards the issues and leaves a policy panel that says something went wrong
 * without saying what.
 */
export async function evaluatePolicy(body: unknown): Promise<Result<PolicyEvaluationResponse>> {
  return request("/v1/policies/evaluate", evaluatePolicyResponseSchema, body, [422]);
}

export async function readActionStatus(actionId: string): Promise<Result<ActionStatus>> {
  return request(`/v1/actions/${encodeURIComponent(actionId)}`, actionStatusResponseSchema);
}

export type VaultList = z.infer<typeof vaultListResponseSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
export type PolicyEvaluationResponse = z.infer<typeof evaluatePolicyResponseSchema>;
export type ActionStatus = z.infer<typeof actionStatusResponseSchema>;

/**
 * One request, parsed both ways.
 *
 * `cache: "no-store"` because evidence is pinned to a block and the question "what is true now" is
 * the one every page here asks. A cached vault list would quietly answer a question about the past
 * while the page around it claimed to be current.
 */
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  /** Non-2xx codes whose body is still the ordinary response, not the error envelope. */
  answeredStatuses: readonly number[] = [],
): Promise<Result<T>> {
  // Built rather than spread with undefined members: `exactOptionalPropertyTypes` is on, and an
  // explicit `body: undefined` is a different thing from an absent one.
  const init: RequestInit =
    body === undefined
      ? { method: "GET", cache: "no-store" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        };

  let response: Response;

  try {
    response = await fetch(`${baseUrl()}${path}`, init);
  } catch (cause) {
    // The API is not answering. A distinct condition from "the API refused", and the page says so
    // rather than showing an empty result that reads as "there is nothing".
    return {
      ok: false,
      status: 503,
      error: {
        code: "INTERNAL_ERROR",
        message: `The evidence API did not answer: ${describe(cause)}`,
        reasonCodes: [],
        issues: [],
      },
    };
  }

  const text = await response.text();

  if (!response.ok && !answeredStatuses.includes(response.status)) {
    const parsed = apiErrorSchema.safeParse(parseJson(text));

    return {
      ok: false,
      status: response.status,
      error: parsed.success
        ? parsed.data.error
        : {
            // A failure that did not arrive in the shared envelope is itself worth reporting as
            // one, rather than being smoothed into a generic message that hides the difference.
            code: "INTERNAL_ERROR",
            message: `The evidence API answered ${response.status} outside its error contract.`,
            reasonCodes: [],
            issues: [],
          },
    };
  }

  return { ok: true, value: schema.parse(parseJson(text)) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
