import {
  evidenceReportV1Schema,
  type CapabilityProbe,
  type PolicyEvaluation,
  type VaultIdentity,
} from "@tr4ce/domain";
import { describe, expect, it } from "vitest";

import type { FlowRow } from "./flows.js";
import {
  attachPolicy,
  buildEvidence,
  isComplete,
  type EvidenceInput,
  type SnapshotObservation,
} from "./report.js";

const VAULT = {
  chainId: 8453,
  address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  assetSymbol: "USDC",
} as VaultIdentity;

const probe = (method: string, status: string): CapabilityProbe =>
  ({
    method,
    status,
    atBlock: "50577041",
    rawResult: null,
    revertData: null,
    reasonCode: null,
    note: null,
  }) as CapabilityProbe;

const snapshot = (overrides: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  vaultId: "11111111-1111-5111-8111-111111111111",
  blockNumber: "50879897",
  blockHash: `0x${"1".repeat(64)}`,
  blockTime: "2026-09-04T12:00:00.000Z",
  totalAssets: 417_000_000_000n,
  totalSupply: 400_000_000_000n,
  oneShareUnits: 1_000_000_000_000_000_000n,
  oneShareAssets: 1_052_300n,
  schemaVersion: "1.0.0",
  ...overrides,
});

const startSnapshot = (overrides: Partial<SnapshotObservation> = {}): SnapshotObservation =>
  snapshot({
    blockNumber: "50577041",
    blockHash: `0x${"2".repeat(64)}`,
    // Exactly seven days before the end snapshot.
    blockTime: "2026-08-28T12:00:00.000Z",
    oneShareAssets: 1_041_000n,
    ...overrides,
  });

const input = (overrides: Partial<EvidenceInput> = {}): EvidenceInput => ({
  vault: VAULT,
  asOf: {
    blockNumber: "50879897",
    blockHash: `0x${"1".repeat(64)}`,
    timestamp: "2026-09-04T12:00:00.000Z",
  },
  start: startSnapshot(),
  end: snapshot(),
  flows: [],
  accountLimits: null,
  capability: { adapterKey: "morpho-v2", adapterVersion: "metamorpho-1.1", probes: [] },
  windowDays: 7,
  calculationVersion: "1.0.0",
  generatedAt: "2026-09-05T00:00:00.000Z",
  ...overrides,
});

const PASSING_POLICY: PolicyEvaluation = { version: 1, status: "PASS", rules: [] };

describe("buildEvidence", () => {
  it("computes the observed share-value return over the window", () => {
    const draft = buildEvidence(input());

    expect(draft.observations.shareValue).toMatchObject({
      assetsAtStart: "1041000",
      assetsNow: "1052300",
      windowDays: 7,
      returnBps: 108,
      rounding: "floor",
    });
    expect(draft.reasonCodes).toEqual([]);
    expect(isComplete(draft)).toBe(true);
  });

  it("keeps the raw ratio alongside the formatted value", () => {
    // PRD TR-F-013: numerator, denominator, rounding direction and value all exposed, so a reader
    // can re-derive the number rather than trust it.
    const draft = buildEvidence(input());

    expect(draft.observations.shareValue?.numerator).toBe(113n);
    expect(draft.observations.shareValue?.denominator).toBe(10_410n);
  });

  it("measures the actual elapsed window rather than assuming it", () => {
    const draft = buildEvidence(input());

    expect(draft.elapsedSeconds).toBe(7 * 86_400);
  });

  it("says so when the observations are not the requested distance apart", () => {
    // A 7-day return measured over 5 days is a different number; the report has to admit that.
    const draft = buildEvidence(
      input({ start: startSnapshot({ blockTime: "2026-08-30T12:00:00.000Z" }) }),
    );

    expect(draft.elapsedSeconds).toBe(5 * 86_400);
    expect(draft.limitations.some((line) => line.includes("5.00 days apart"))).toBe(true);
  });

  it("reports no share value when the start observation is absent", () => {
    const draft = buildEvidence(input({ start: null }));

    expect(draft.observations.shareValue).toBeNull();
    expect(draft.reasonCodes).toContain("MISSING_OBSERVATION");
    expect(isComplete(draft)).toBe(false);
  });

  it("reports no share value when the start read produced nothing", () => {
    // total_assets/one_share_assets arrive as null when the call failed. A zero here would be a
    // fabricated -100% or +inf return depending on which side it landed.
    const draft = buildEvidence(input({ start: startSnapshot({ oneShareAssets: null }) }));

    expect(draft.observations.shareValue).toBeNull();
    expect(draft.reasonCodes).toContain("MISSING_OBSERVATION");
  });

  it("distinguishes an unusable zero start from an absent one", () => {
    const absent = buildEvidence(input({ start: null }));
    const zero = buildEvidence(input({ start: startSnapshot({ oneShareAssets: 0n }) }));

    expect(absent.reasonCodes).toContain("MISSING_OBSERVATION");
    expect(zero.reasonCodes).toContain("AMBIGUOUS_CAPABILITY");
  });

  it("refuses to compute across a share-decimals change", () => {
    // Different share units means the two figures are not the same quantity; a ratio between them
    // is arithmetic, not evidence (PRD TR-F-012).
    const draft = buildEvidence(
      input({ start: startSnapshot({ oneShareUnits: 1_000_000n }) }),
    );

    expect(draft.reasonCodes).toContain("INCOMPATIBLE_IMPLEMENTATION");
    expect(draft.observations.shareValue).toBeNull();
    expect(
      draft.limitations.some((line) => line.includes("not comparable")),
    ).toBe(true);
  });

  it("refuses to compute across a producer schema change", () => {
    // Reported as an implementation change, never INCOMPATIBLE_ASSET: the underlying token did not
    // change, and claiming it did would tell a reader the vault swapped its asset.
    const draft = buildEvidence(input({ start: startSnapshot({ schemaVersion: "2.0.0" }) }));

    expect(draft.reasonCodes).toContain("INCOMPATIBLE_IMPLEMENTATION");
    expect(draft.reasonCodes).not.toContain("INCOMPATIBLE_ASSET");
    expect(draft.observations.shareValue).toBeNull();
  });

  it("throws rather than computing a return across two different vaults", () => {
    /*
     * Task 3 makes this impossible in the database through composite foreign keys; nothing
     * structural prevents it here. It throws instead of returning a reason code because UNKNOWN is
     * a normal outcome that gets rendered and moved past, and this is a caller bug that would
     * otherwise surface as an ordinary data gap.
     */
    const foreign = snapshot({ vaultId: "22222222-2222-5222-8222-222222222222" });

    expect(() => buildEvidence(input({ start: foreign }))).toThrow(/two vaults/);
  });

  it("reports totalAssets as unavailable when the read reverted", () => {
    const draft = buildEvidence(input({ end: snapshot({ totalAssets: null }) }));

    expect(draft.observations.totalAssets).toBeNull();
    expect(draft.reasonCodes).toContain("CALL_REVERTED");
    expect(isComplete(draft)).toBe(false);
  });

  it("treats a non-standard zero maxWithdraw as unavailable, not as zero liquidity", () => {
    /*
     * Morpho Vault V2 documents maxWithdraw returning zero for an owner who holds shares. Reading
     * that as a real zero would assert the account cannot withdraw anything and fail a policy rule
     * on a vault that is fine.
     */
    const draft = buildEvidence(
      input({
        accountLimits: {
          blockNumber: "50879900",
          blockHash: `0x${"3".repeat(64)}`,
          maxWithdrawAssets: 0n,
          probes: [probe("maxWithdraw", "nonstandard_zero")],
        },
      }),
    );

    expect(draft.observations.maxWithdrawAssets).toBeNull();
    expect(draft.reasonCodes).toContain("AMBIGUOUS_CAPABILITY");
    expect(draft.limitations.some((line) => line.includes("rather than as zero"))).toBe(true);
  });

  it("reports a supported maxWithdraw", () => {
    const draft = buildEvidence(
      input({
        accountLimits: {
          blockNumber: "50879900",
          blockHash: `0x${"3".repeat(64)}`,
          maxWithdrawAssets: 10_000_000_000n,
          probes: [probe("maxWithdraw", "supported")],
        },
      }),
    );

    expect(draft.observations.maxWithdrawAssets).toBe("10000000000");
  });

  it("carries a source reference for every observation it used", () => {
    // TR-F-010: every claim traces to a block. Current account reads are labelled apart from
    // indexed history, because they are deliberately newer than the report block.
    const draft = buildEvidence(
      input({
        accountLimits: {
          blockNumber: "50879900",
          blockHash: `0x${"3".repeat(64)}`,
          maxWithdrawAssets: 1n,
          probes: [probe("maxWithdraw", "supported")],
        },
      }),
    );

    expect(draft.provenance.map((entry) => entry.reference)).toEqual([
      "vault_snapshot.end",
      "vault_snapshot.start",
      "account_limits.maxWithdraw",
    ]);
    expect(draft.provenance.filter((entry) => entry.sourceType === "rpc")).toHaveLength(1);
  });

  it("always carries the backward-looking limitation", () => {
    const draft = buildEvidence(input());

    expect(draft.limitations[0]).toBe(
      "Observed share-value return is backward-looking and is not a forecast.",
    );
  });

  it("states that net flow excludes the share side of each event", () => {
    const flows: FlowRow[] = [
      { kind: "deposit", transferKind: null, assets: 1_000n, shares: 1n, canonical: true },
      { kind: "share_transfer", transferKind: "mint", assets: null, shares: 1n, canonical: true },
    ];

    const draft = buildEvidence(input({ flows }));

    expect(draft.observations.netFlowAssets).toBe("1000");
    expect(draft.limitations.some((line) => line.includes("share mint"))).toBe(true);
  });

  it("labels net flow a lower bound when an amount was unavailable", () => {
    const flows: FlowRow[] = [
      { kind: "deposit", transferKind: null, assets: null, shares: 1n, canonical: true },
    ];

    const draft = buildEvidence(input({ flows }));

    expect(draft.limitations.some((line) => line.includes("lower bound"))).toBe(true);
  });
});

describe("reproducibility", () => {
  it("produces an identical report from identical input", () => {
    // PRD TR-F-016. If the id or any field drifted between runs, a persisted report could not be
    // checked against a re-derivation of it.
    const first = buildEvidence(input());
    const second = buildEvidence(input());

    expect(first).toEqual(second);
    expect(first.reportId).toBe(second.reportId);
  });

  it("derives an id that matches the pinned fixture", () => {
    // Pinned so an accidental change to the hashed input surface is caught, not just an unstable
    // one. Update deliberately and never to make a test pass.
    expect(buildEvidence(input()).reportId).toBe("trc_1d3d1540e28b24ec3c56bd4cd424a5f8");
  });

  it("changes the id when any observed value changes", () => {
    const base = buildEvidence(input());
    const nudged = buildEvidence(input({ end: snapshot({ oneShareAssets: 1_052_301n }) }));

    expect(nudged.reportId).not.toBe(base.reportId);
  });

  it("changes the id when the calculation version changes", () => {
    // The same observations under a different calculation are a different report, not an update.
    const base = buildEvidence(input());
    const revised = buildEvidence(input({ calculationVersion: "1.1.0" }));

    expect(revised.reportId).not.toBe(base.reportId);
  });

  it("does not read the clock", () => {
    // generatedAt is an input. If the engine reached for Date.now(), two calls a millisecond apart
    // would differ and nothing here would be reproducible.
    const early = buildEvidence(input({ generatedAt: "2026-09-05T00:00:00.000Z" }));
    const later = buildEvidence(input({ generatedAt: "2026-09-05T00:00:00.000Z" }));

    expect(early.generatedAt).toBe(later.generatedAt);
    expect(early.reportId).toBe(later.reportId);
  });
});

describe("attachPolicy", () => {
  it("produces a report that validates against the published V1 schema", () => {
    const report = attachPolicy(buildEvidence(input()), PASSING_POLICY);

    expect(() => evidenceReportV1Schema.parse(report)).not.toThrow();
    expect(report.reportId).toMatch(/^trc_[A-Za-z0-9]+$/);
    expect(report.observations.shareValue.returnBps).toBe(108);
  });

  it("refuses to publish an incomplete report rather than inventing a value", () => {
    // The V1 contract has no way to express "no share value", so the honest outcome is no report —
    // not a report carrying a number nobody measured.
    const draft = buildEvidence(input({ start: null }));

    expect(() => attachPolicy(draft, PASSING_POLICY)).toThrow(/incomplete/);
  });

  it("serialises token amounts as decimal strings, never numbers", () => {
    const report = attachPolicy(buildEvidence(input()), PASSING_POLICY);
    const json = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const observations = (json["observations"] as Record<string, unknown>);

    for (const key of ["totalAssets", "netFlowAssets"]) {
      expect(typeof observations[key]).toBe("string");
    }
  });
});
