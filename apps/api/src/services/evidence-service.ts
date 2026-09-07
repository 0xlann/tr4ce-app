import {
  blockTimestamp,
  createChainClient,
  prepareDeposit as prepareDepositCalls,
  prepareRedeem as prepareRedeemCalls,
  simulateCall,
  type ChainClient,
} from "@tr4ce/chain";
import {
  insertReport,
  insertRuleResults,
  readObservationWindow,
  readReport,
  storePolicyVersion,
  vaultId as deriveVaultId,
  type Database,
  type ReportCitation,
} from "@tr4ce/db";
import { reportStatusSchema } from "@tr4ce/domain";
import type {
  PolicyRuleKey,
  PolicyRuleStatus,
  PolicyV1,
  ReportStatus,
} from "@tr4ce/domain";
import {
  attachPolicy,
  buildEvidence,
  isComplete,
  type EvidenceInput,
  type EvidenceReportDraft,
  type FlowRow,
  type SnapshotObservation,
} from "@tr4ce/evidence";
import { evaluatePolicy } from "@tr4ce/policy";

import { ApiFailure } from "../errors.js";
import type { CreateReportRequest, ReportResponse } from "../contract.js";
import { identityOf, type VaultRegistryEntry } from "./registry-service.js";

/**
 * Turning promoted observations into a stored report.
 *
 * The engine in @tr4ce/evidence is pure, and everything it needs is assembled here. Nothing in this
 * file decides what a number means; it reads rows, hands them over, and stores what comes back.
 *
 * Every report carries a policy. `evidenceReportV1Schema` requires one, so an evidence-only report
 * has no wire shape to be served as — the `not_evaluated` status exists in the schema because ERD
 * section 6 defines it, and it is unreachable through this API. That is stated rather than hidden:
 * an endpoint that quietly produced a report the response contract cannot express would fail at the
 * boundary with nothing useful to say.
 */

/**
 * The only thing this service needs from a chain.
 *
 * Narrowed to one method rather than taking a `PublicClient`, so the integration tests can supply
 * a fixed answer instead of reaching for a provider. The narrowing is honest: resolving a
 * deployment block to a time is genuinely all the API does on-chain — every other number in a
 * report comes from a promoted row.
 */
export interface ChainTime {
  blockTimestamp(blockNumber: bigint): Promise<string | null>;
}

/** Adapt a viem client to the seam above. */
export function chainTimeFrom(client: ChainClient): ChainTime {
  return { blockTimestamp: (blockNumber) => blockTimestamp(client, blockNumber) };
}

export interface EvidenceServiceOptions {
  db: Database;
  chain: ChainTime;
  /** Version string recorded on every report this build produces. */
  calculationVersion: string;
  /** Supplied so the service never reads the clock itself; tests pin it. */
  now: () => Date;
}

export function createChain(rpcUrl: string): ChainClient {
  return createChainClient(rpcUrl);
}

export interface DraftContext {
  draft: EvidenceReportDraft;
  window: Awaited<ReturnType<typeof readObservationWindow>>;
  assetIdentity: { canonicalKey: string | null };
  vaultDeployedAt: string | null;
  asOf: { blockNumber: string; blockHash: string; timestamp: string };
}

/**
 * Gather observations and run the pure engine over them.
 *
 * Shared by `POST /v1/reports` and `POST /v1/policies/evaluate`, which differ only in what they do
 * afterwards: one stores the result, the other answers and forgets. Sharing the gathering is what
 * keeps a policy preview and the report it previews from being computed two different ways.
 */
export async function buildDraft(
  options: EvidenceServiceOptions,
  request: { chainId: number; windowDays: number },
  vault: VaultRegistryEntry,
): Promise<DraftContext> {
  const { db, calculationVersion, now } = options;
  const asOfBlock = vault.attestedBlock;

  if (asOfBlock === null) {
    throw new ApiFailure(
      "INSUFFICIENT_OBSERVATIONS",
      409,
      `No confirmed observations have been promoted for chain ${request.chainId} yet.`,
      { reasonCodes: ["MISSING_OBSERVATION"] },
    );
  }

  const window = await readObservationWindow(db, {
    vaultId: vault.vaultId,
    asOfBlock,
    startBlock: estimateStartBlock(asOfBlock, request.windowDays, vault.blockSeconds),
  });

  if (window.end === null || window.capability === null) {
    throw new ApiFailure(
      "INSUFFICIENT_OBSERVATIONS",
      409,
      `No canonical snapshot has been promoted for ${vault.address} at or below block ${asOfBlock}.`,
      { reasonCodes: ["MISSING_OBSERVATION"] },
    );
  }

  const asOf = {
    blockNumber: window.end.blockNumber,
    blockHash: window.end.blockHash,
    timestamp: window.end.blockTime.toISOString(),
  };

  const input: EvidenceInput = {
    vault: identityOf(vault),
    asOf,
    start: window.start === null ? null : toSnapshot(window.start),
    end: toSnapshot(window.end),
    flows: window.flows.map(toFlowRow),
    // Account-scoped reads are current, not historical, and belong to the request rather than the
    // window. Left null: the withdrawable rule then reports UNKNOWN, which is the honest answer
    // when nothing was read for that owner.
    accountLimits: null,
    capability: {
      adapterKey: window.capability.adapterKey,
      adapterVersion: window.capability.adapterVersion,
      probes: vault.probes,
    },
    windowDays: request.windowDays,
    calculationVersion,
    generatedAt: now().toISOString(),
  };

  return {
    draft: buildEvidence(input),
    window,
    // What the rule needs is whether the asset matched a curated one; the address itself is
    // already on the report identity.
    assetIdentity: { canonicalKey: vault.assetCanonicalKey },
    vaultDeployedAt: await resolveDeploymentTime(options, vault),
    asOf,
  };
}

export async function createReport(
  options: EvidenceServiceOptions,
  request: CreateReportRequest,
  vault: VaultRegistryEntry,
): Promise<ReportResponse> {
  const { db, calculationVersion } = options;
  const context = await buildDraft(options, request, vault);
  const { draft, window } = context;

  if (!isComplete(draft)) {
    throw new ApiFailure(
      "INCOMPLETE_EVIDENCE",
      409,
      `Evidence for ${vault.address} is incomplete over the requested window; the V1 contract cannot represent a missing observation.`,
      { reasonCodes: draft.reasonCodes },
    );
  }

  const evaluation = evaluatePolicy({
    policy: request.policy,
    draft,
    assetIdentity: context.assetIdentity,
    vaultDeployedAt: context.vaultDeployedAt,
    // Nothing was read for an owner, so nothing may be claimed about one.
    observedOwner: null,
  });

  const report = attachPolicy(draft, evaluation);
  const citations = citationsFor({ start: window.start, end: window.end!, flows: window.flows });

  const stored = await db.transaction(async (tx) => {
    const policyVersion = await storePolicyVersion(tx, {
      policy: request.policy,
      name: request.policyName,
      source: "manual",
    });

    const result = await insertReport(tx, {
      reportId: draft.reportId,
      canonicalInputHash: draft.canonicalInputHash,
      vaultId: vault.vaultId,
      chainId: request.chainId,
      policyVersionId: policyVersion.policyVersionId,
      asOf: context.asOf,
      windowSeconds: request.windowDays * 24 * 60 * 60,
      actualElapsedSeconds: draft.elapsedSeconds,
      calculationVersion,
      schemaVersion: report.schemaVersion,
      status: statusOf(evaluation.status),
      resultJson: report,
      citations,
    });

    if (result.created) {
      await insertRuleResults(tx, {
        reportId: result.reportId,
        policyVersionId: policyVersion.policyVersionId,
        ruleIds: Object.fromEntries(
          policyVersion.rules.map((rule) => [rule.ruleKey, rule.id]),
        ) as Record<PolicyRuleKey, string>,
        evaluation,
        thresholds: thresholdsOf(request.policy),
      });
    }

    return result;
  });

  return {
    schemaVersion: "1.0.0",
    created: stored.created,
    // Read back from the row rather than returned from memory, so a repeat request serves what is
    // actually stored instead of a freshly assembled report that merely looks equal.
    report: (stored.resultJson ?? report) as ReportResponse["report"],
  };
}

export async function fetchReport(db: Database, reportId: string): Promise<unknown> {
  const stored = await readReport(db, reportId);

  if (stored === null) {
    throw new ApiFailure("REPORT_NOT_FOUND", 404, `No report with id ${reportId}.`);
  }

  return stored.resultJson;
}

/** Which observations the report rests on, in a stable order. */
function citationsFor(window: {
  start: { id: string } | null;
  end: { id: string };
  flows: readonly { id: string }[];
}): ReportCitation[] {
  const citations: ReportCitation[] = [];

  if (window.start !== null) {
    citations.push({
      observationType: "snapshot",
      observationId: window.start.id,
      purpose: "start",
    });
  }

  citations.push({ observationType: "snapshot", observationId: window.end.id, purpose: "end" });

  for (const flow of window.flows) {
    citations.push({ observationType: "flow", observationId: flow.id, purpose: "net_flow" });
  }

  return citations;
}

/**
 * Where the window opens, in blocks.
 *
 * An estimate, and named one. Block times drift, so this picks a candidate range and the query
 * takes the nearest snapshot at or before it; the report then states the elapsed time it actually
 * measured rather than the one requested.
 */
function estimateStartBlock(asOfBlock: string, windowDays: number, blockSeconds: number): string {
  const span = BigInt(Math.ceil((windowDays * 24 * 60 * 60) / blockSeconds));
  const start = BigInt(asOfBlock) - span;

  return (start < 0n ? 0n : start).toString();
}

async function resolveDeploymentTime(
  options: EvidenceServiceOptions,
  vault: VaultRegistryEntry,
): Promise<string | null> {
  if (vault.deploymentBlock === null) {
    return null;
  }

  // A provider that cannot answer yields null, which the evaluator reads as "unknown history"
  // rather than as a young vault. Never guessed.
  return options.chain.blockTimestamp(BigInt(vault.deploymentBlock));
}

function toSnapshot(row: {
  id: string;
  vaultId: string;
  blockNumber: string;
  blockHash: string;
  blockTime: Date;
  totalAssets: string | null;
  totalSupply: string | null;
  oneShareUnits: string;
  oneShareAssets: string | null;
  schemaVersion: string;
}): SnapshotObservation {
  return {
    vaultId: row.vaultId,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    blockTime: row.blockTime.toISOString(),
    // NULL stays null all the way through. A zero here would read as a vault that lost everything.
    totalAssets: row.totalAssets === null ? null : BigInt(row.totalAssets),
    totalSupply: row.totalSupply === null ? null : BigInt(row.totalSupply),
    oneShareUnits: BigInt(row.oneShareUnits),
    oneShareAssets: row.oneShareAssets === null ? null : BigInt(row.oneShareAssets),
    schemaVersion: row.schemaVersion,
  };
}

function toFlowRow(row: {
  kind: string;
  transferKind: string | null;
  assets: string | null;
  shares: string;
  canonical: boolean;
}): FlowRow {
  return {
    kind: row.kind as FlowRow["kind"],
    transferKind: row.transferKind as FlowRow["transferKind"],
    assets: row.assets === null ? null : BigInt(row.assets),
    shares: BigInt(row.shares),
    canonical: row.canonical,
  };
}

/**
 * The overall verdict in its stored spelling.
 *
 * Parsed rather than cast, matching `persistedRuleStatus` one layer down: a cast would keep
 * compiling if the wire enum gained a value the column's CHECK does not allow, and the failure
 * would surface as a constraint violation on insert instead of here.
 */
function statusOf(status: PolicyRuleStatus): ReportStatus {
  return reportStatusSchema.parse(status.toLowerCase());
}

function thresholdsOf(policy: PolicyV1): Record<PolicyRuleKey, unknown> {
  return {
    underlyingAsset: policy.underlyingAssets,
    minimumHistory: policy.minHistoryDays,
    minimumTvl: policy.minTvlAssets,
    minimumObservedReturn: policy.minObservedReturnBps,
    minimumWithdrawableAssets: policy.minWithdrawableAssets,
  };
}

export type { EvidenceReportDraft };

/**
 * The action half of the chain, backed by a real viem client.
 *
 * Lives beside `chainTimeFrom` for the same reason: the app takes narrow interfaces so tests can
 * answer with fixtures, and the adapters that satisfy them with a real provider belong in one
 * place rather than scattered across route files.
 */
export function actionChainFrom(client: ChainClient) {
  return {
    async prepareDeposit(input: {
      vault: string;
      asset: string;
      owner: string;
      receiver: string;
      assets: bigint;
    }) {
      const result = await prepareDepositCalls(client, {
        vault: input.vault as `0x${string}`,
        asset: input.asset as `0x${string}`,
        owner: input.owner as `0x${string}`,
        receiver: input.receiver as `0x${string}`,
        assets: input.assets,
      });

      return result.ok
        ? { ok: true as const, calls: result.value.calls, previewed: result.value.previewedShares }
        : { ok: false as const, code: result.failure.code };
    },

    async prepareRedeem(input: {
      vault: string;
      owner: string;
      receiver: string;
      shares: bigint;
    }) {
      const result = await prepareRedeemCalls(client, {
        vault: input.vault as `0x${string}`,
        owner: input.owner as `0x${string}`,
        receiver: input.receiver as `0x${string}`,
        shares: input.shares,
      });

      return result.ok
        ? { ok: true as const, calls: result.value.calls, previewed: result.value.previewedAssets }
        : { ok: false as const, code: result.failure.code };
    },

    async currentBlock() {
      const block = await client.getBlock();

      return { number: block.number, hash: block.hash, timestamp: Number(block.timestamp) };
    },

    simulate(input: Parameters<typeof simulateCall>[1]) {
      return simulateCall(client, input);
    },
  };
}
