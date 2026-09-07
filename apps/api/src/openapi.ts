import {
  apiErrorSchema,
  evidenceReportV1Schema,
  policyEvaluationSchema,
  policyV1Schema,
  preparedActionV1Schema,
} from "@tr4ce/domain";
import { z } from "zod";

import {
  actionStatusResponseSchema,
  createReportRequestSchema,
  evaluatePolicyRequestSchema,
  evaluatePolicyResponseSchema,
  prepareActionRequestSchema,
  preparedActionResponseSchema,
  reportResponseSchema,
  reportSubmissionRequestSchema,
  vaultListResponseSchema,
  vaultSummarySchema,
} from "./contract.js";

/**
 * The OpenAPI document, generated from the same zod schemas the routes parse through.
 *
 * TECH-STACK.md section 8: "Do not maintain handwritten copies." There is none — this is derived,
 * written to `openapi.json` by `pnpm --filter @tr4ce/api openapi`, and a test regenerates it and
 * fails on any difference. That is the fourth instance of a pattern that has already caught real
 * divergence three times in this repository.
 *
 * OpenAPI 3.1 rather than 3.0: `z.toJSONSchema` emits JSON Schema draft 2020-12, which 3.0 cannot
 * express. Targeting 3.0 would mean hand-translating every schema, which is the copy this exists to
 * avoid.
 */

const registry = {
  ApiError: apiErrorSchema,
  VaultSummary: vaultSummarySchema,
  VaultListResponse: vaultListResponseSchema,
  CreateReportRequest: createReportRequestSchema,
  ReportResponse: reportResponseSchema,
  EvidenceReportV1: evidenceReportV1Schema,
  EvaluatePolicyRequest: evaluatePolicyRequestSchema,
  EvaluatePolicyResponse: evaluatePolicyResponseSchema,
  PolicyV1: policyV1Schema,
  PolicyEvaluation: policyEvaluationSchema,
  PrepareActionRequest: prepareActionRequestSchema,
  PreparedActionResponse: preparedActionResponseSchema,
  PreparedActionV1: preparedActionV1Schema,
  ActionStatusResponse: actionStatusResponseSchema,
  ReportSubmissionRequest: reportSubmissionRequestSchema,
} as const;

const ref = (name: keyof typeof registry) => ({ $ref: `#/components/schemas/${name}` });

const json = (name: keyof typeof registry) => ({
  "application/json": { schema: ref(name) },
});

/** Every route answers failures with the one envelope, so the responses are declared once. */
const errorResponses = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      String(code),
      { description: descriptionFor(code), content: json("ApiError") },
    ]),
  );

function descriptionFor(code: number): string {
  switch (code) {
    case 400:
      return "The request body or query does not match the schema.";
    case 404:
      return "No such vault or report.";
    case 409:
      return "The observations or chain state needed to answer do not allow it.";
    case 501:
      return "This deployment has no chain configured for actions.";
    default:
      return "The request could not be completed.";
  }
}

export function buildOpenApiDocument(): unknown {
  return {
    openapi: "3.1.0",
    info: {
      title: "TR4CE Evidence API",
      version: "1.0.0",
      description:
        "Vault evidence derived from confirmed on-chain observations. Every report cites the exact rows it rests on, and a repeated request over identical observations returns the report that already exists rather than a new one.",
    },
    paths: {
      "/v1/vaults": {
        get: {
          operationId: "listVaults",
          summary: "List curated vaults.",
          parameters: [
            {
              name: "chainId",
              in: "query",
              required: false,
              schema: { type: "integer", default: 8453 },
            },
          ],
          responses: {
            "200": { description: "The curated registry.", content: json("VaultListResponse") },
            ...errorResponses(400),
          },
        },
      },
      "/v1/reports": {
        post: {
          operationId: "createReport",
          summary: "Produce an evidence report, or return the one that already exists.",
          requestBody: { required: true, content: json("CreateReportRequest") },
          responses: {
            "200": {
              description: "An equivalent report was already stored; nothing was created.",
              content: json("ReportResponse"),
            },
            "201": { description: "A new report was stored.", content: json("ReportResponse") },
            ...errorResponses(400, 404, 409),
          },
        },
      },
      "/v1/reports/{id}": {
        get: {
          operationId: "getReport",
          summary: "Read a stored report exactly as it was served.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^trc_[0-9a-f]{32}$" },
            },
          ],
          responses: {
            "200": { description: "The stored report.", content: json("ReportResponse") },
            ...errorResponses(404),
          },
        },
      },
      "/v1/policies/evaluate": {
        post: {
          operationId: "evaluatePolicy",
          summary: "Evaluate a candidate policy without storing anything.",
          requestBody: { required: true, content: json("EvaluatePolicyRequest") },
          responses: {
            "200": {
              description: "The evaluation.",
              content: json("EvaluatePolicyResponse"),
            },
            "422": {
              description: "The candidate policy did not validate; issues are returned.",
              content: json("EvaluatePolicyResponse"),
            },
            ...errorResponses(400, 404, 409),
          },
        },
      },
      "/v1/actions/prepare": {
        post: {
          operationId: "prepareAction",
          summary: "Build the unsigned calls for a deposit or redemption, and simulate the first.",
          description:
            "Returns unsigned transactions only. TR4CE never signs and never submits: the wallet owner approves each call, and only the first unsent call is simulated because the second reverts until the first has landed.",
          requestBody: { required: true, content: json("PrepareActionRequest") },
          responses: {
            "200": {
              description: "The prepared action, with the first call simulated.",
              content: json("PreparedActionResponse"),
            },
            ...errorResponses(400, 404, 409, 501),
          },
        },
      },
      "/v1/actions/{id}": {
        get: {
          operationId: "getActionStatus",
          summary: "Whether a prepared action may still be signed, judged now.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^act_[0-9a-f]{32}$" },
            },
          ],
          responses: {
            "200": { description: "The action's standing.", content: json("ActionStatusResponse") },
            ...errorResponses(404, 501),
          },
        },
      },
      "/v1/actions/{id}/submitted": {
        post: {
          operationId: "reportActionSubmission",
          summary: "Report the transaction hash a wallet produced.",
          description:
            "The only route by which a transaction hash enters TR4CE, and it arrives as a report about something that already happened in the caller's wallet.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^act_[0-9a-f]{32}$" },
            },
          ],
          requestBody: { required: true, content: json("ReportSubmissionRequest") },
          responses: {
            "200": {
              description: "The action's standing after the report.",
              content: json("ActionStatusResponse"),
            },
            ...errorResponses(400, 404, 409, 501),
          },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(
        Object.entries(registry).map(([name, schema]) => [
          name,
          z.toJSONSchema(schema, { io: "output" }),
        ]),
      ),
    },
  };
}
