import { apiErrorSchema, type ApiError, type ApiErrorCode, type ReasonCode } from "@tr4ce/domain";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/**
 * Structured failures (PRD TR-F-040).
 *
 * One shape for every route. A route that invented its own would have that inconsistency frozen
 * into the generated OpenAPI document by the drift check, which is the opposite of what the check
 * is for.
 */

export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly status: ContentfulStatusCode;
  readonly reasonCodes: readonly ReasonCode[];
  readonly issues: readonly { path: string; message: string }[];

  constructor(
    code: ApiErrorCode,
    status: ContentfulStatusCode,
    message: string,
    extra: {
      reasonCodes?: readonly ReasonCode[];
      issues?: readonly { path: string; message: string }[];
    } = {},
  ) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
    this.reasonCodes = extra.reasonCodes ?? [];
    this.issues = extra.issues ?? [];
  }

  /** Parsed on the way out, like every other response: the envelope is part of the contract. */
  toBody(): ApiError {
    return apiErrorSchema.parse({
      error: {
        code: this.code,
        message: this.message,
        reasonCodes: [...this.reasonCodes],
        issues: this.issues.map((issue) => ({ ...issue })),
      },
    });
  }
}

/** Flatten a zod error into the envelope's issue list. */
export function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function invalidRequest(error: z.ZodError): ApiFailure {
  return new ApiFailure("INVALID_REQUEST", 400, "The request body does not match the schema.", {
    issues: issuesOf(error),
  });
}
