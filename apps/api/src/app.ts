import type { Database } from "@tr4ce/db";
import { evaluatePolicy, validatePolicy } from "@tr4ce/policy";
import { Hono } from "hono";

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
} from "./contract.js";
import { ApiFailure, invalidRequest } from "./errors.js";
import {
  buildDraft,
  createReport,
  fetchReport,
  type ChainTime,
} from "./services/evidence-service.js";
import {
  actionSignability,
  prepareAction,
  reportSubmission,
  type ActionChain,
} from "./services/action-service.js";
import { identityOf, listVaults, requireVault } from "./services/registry-service.js";

/**
 * The versioned HTTP surface.
 *
 * Routes parse, call a service, and serialise. They compute nothing: every number in a response
 * came out of @tr4ce/evidence, and every verdict out of @tr4ce/policy. Keeping the handlers this
 * thin is what lets the same services back the MCP tools in Task 8 without a second implementation
 * of the rules appearing alongside the first.
 *
 * Both directions go through a schema. Parsing the response is not ceremony: it is how "HTTP output
 * equals the domain schema exactly" becomes something the code enforces rather than something the
 * documentation claims.
 */

export interface AppOptions {
  db: Database;
  chain: ChainTime;
  /**
   * The action half of the chain, kept separate from `ChainTime`.
   *
   * Optional: an API deployed without it still serves evidence and policy. The action routes then
   * answer 501 rather than pretending to prepare something, which is the honest failure for a
   * capability that was never wired up.
   */
  actionChain?: ActionChain;
  /** Names the provider on stored simulations. Never a credential. */
  providerKey?: string;
  calculationVersion: string;
  streamKey: string;
  blockSeconds: number;
  /** Injected so the app never reads the clock directly; tests pin it. */
  now?: () => Date;
}

export function createApp(options: AppOptions) {
  const now = options.now ?? (() => new Date());
  const registry = {
    db: options.db,
    streamKey: options.streamKey,
    blockSeconds: options.blockSeconds,
  };
  const evidence = {
    db: options.db,
    chain: options.chain,
    calculationVersion: options.calculationVersion,
    now,
  };

  const actions =
    options.actionChain === undefined
      ? null
      : {
          db: options.db,
          chain: options.actionChain,
          providerKey: options.providerKey ?? "unspecified",
          now,
        };

  const app = new Hono();

  app.get("/v1/vaults", async (context) => {
    const chainId = Number(context.req.query("chainId") ?? "8453");

    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new ApiFailure("INVALID_REQUEST", 400, "chainId must be a positive integer.");
    }

    return context.json(
      vaultListResponseSchema.parse({
        schemaVersion: "1.0.0",
        vaults: await listVaults(registry, chainId),
      }),
    );
  });

  app.post("/v1/reports", async (context) => {
    const parsed = createReportRequestSchema.safeParse(await readJson(context.req.raw));

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    const vault = await requireVault(registry, parsed.data.chainId, parsed.data.vaultAddress);
    const response = await createReport(evidence, parsed.data, vault);

    // 200 rather than 201 when the report already existed: nothing was created, and a client
    // repeating a request should be able to tell.
    return context.json(reportResponseSchema.parse(response), response.created ? 201 : 200);
  });

  app.get("/v1/reports/:id", async (context) => {
    const stored = await fetchReport(options.db, context.req.param("id"));

    // Served from `result_json` exactly as it was stored, then parsed: a report that no longer
    // satisfies the published contract must fail loudly rather than be handed to a client.
    return context.json(
      reportResponseSchema.parse({ schemaVersion: "1.0.0", created: false, report: stored }),
    );
  });

  app.post("/v1/policies/evaluate", async (context) => {
    const parsed = evaluatePolicyRequestSchema.safeParse(await readJson(context.req.raw));

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    const validation = validatePolicy(parsed.data.policy);

    if (!validation.valid) {
      // Issues, not a rejection: this endpoint exists so a user can be shown what is wrong with a
      // draft policy before it is stored (TR-F-024).
      return context.json(
        evaluatePolicyResponseSchema.parse({
          schemaVersion: "1.0.0",
          evaluation: null,
          issues: validation.issues,
          asOfBlock: null,
        }),
        422,
      );
    }

    const vault = await requireVault(registry, parsed.data.chainId, parsed.data.vaultAddress);
    const { draft, assetIdentity, vaultDeployedAt } = await buildDraft(
      evidence,
      { chainId: parsed.data.chainId, windowDays: parsed.data.windowDays },
      vault,
    );

    const evaluation = evaluatePolicy({
      policy: validation.policy,
      draft,
      assetIdentity,
      vaultDeployedAt,
      observedOwner: null,
    });

    // Nothing is written here. Evaluating a candidate policy is a question, not a claim, and
    // storing it would put an unconfirmed policy in the audit trail.
    return context.json(
      evaluatePolicyResponseSchema.parse({
        schemaVersion: "1.0.0",
        evaluation,
        issues: [],
        asOfBlock: draft.asOf.blockNumber,
      }),
    );
  });

  app.post("/v1/actions/prepare", async (context) => {
    const service = requireActionChain(actions);
    const parsed = prepareActionRequestSchema.safeParse(await readJson(context.req.raw));

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    const vault = await requireVault(registry, parsed.data.chainId, parsed.data.vaultAddress);
    const action = await prepareAction(service, parsed.data, vault);

    // 200, not 201: preparing is idempotent on the binding, so a repeated request under unchanged
    // conditions names the action that already exists rather than creating another.
    return context.json(
      preparedActionResponseSchema.parse({ schemaVersion: "1.0.0", action }),
    );
  });

  app.get("/v1/actions/:id", async (context) => {
    const service = requireActionChain(actions);

    // Judged against the chain now, not read back from the row. The stored status says what was
    // true when it was written, and the binding exists because the world moves afterwards.
    return context.json(
      actionStatusResponseSchema.parse(
        await actionSignability(service, context.req.param("id")),
      ),
    );
  });

  app.post("/v1/actions/:id/submitted", async (context) => {
    /*
     * The only route by which a transaction hash enters TR4CE, and it enters as a report about
     * something that already happened in the caller's wallet. Nothing here submits (PRD TR-F-043).
     */
    const service = requireActionChain(actions);
    const parsed = reportSubmissionRequestSchema.safeParse(await readJson(context.req.raw));

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    return context.json(
      actionStatusResponseSchema.parse(
        await reportSubmission(service, {
          actionId: context.req.param("id"),
          chainId: parsed.data.chainId,
          transactionHash: parsed.data.transactionHash,
        }),
      ),
    );
  });

  app.notFound((context) =>
    context.json(
      new ApiFailure("REPORT_NOT_FOUND", 404, `No route for ${context.req.path}.`).toBody(),
      404,
    ),
  );

  app.onError((error, context) => {
    if (error instanceof ApiFailure) {
      return context.json(error.toBody(), error.status);
    }

    // Nothing internal leaks into the envelope: a driver message can carry a connection string.
    console.error("[api] unhandled", error);

    return context.json(
      new ApiFailure("INTERNAL_ERROR", 500, "The request could not be completed.").toBody(),
      500,
    );
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

/** Refuse action routes on a deployment that was never given a chain to prepare against. */
function requireActionChain<T>(service: T | null): T {
  if (service === null) {
    throw new ApiFailure(
      "INTERNAL_ERROR",
      501,
      "This deployment has no chain configured for actions.",
    );
  }

  return service;
}

/** Read a JSON body, turning a malformed one into the same structured error as a schema failure. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiFailure("INVALID_REQUEST", 400, "The request body is not valid JSON.");
  }
}

export { identityOf };
