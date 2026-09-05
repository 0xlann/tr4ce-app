import { describe, expect, it } from "vitest";

import { aggregateFlows, type FlowRow } from "./flows.js";

const deposit = (assets: bigint, overrides: Partial<FlowRow> = {}): FlowRow => ({
  kind: "deposit",
  transferKind: null,
  assets,
  shares: 1n,
  canonical: true,
  ...overrides,
});

const withdraw = (assets: bigint, overrides: Partial<FlowRow> = {}): FlowRow => ({
  kind: "withdraw",
  transferKind: null,
  assets,
  shares: 1n,
  canonical: true,
  ...overrides,
});

const transfer = (transferKind: FlowRow["transferKind"]): FlowRow => ({
  kind: "share_transfer",
  transferKind,
  assets: null,
  shares: 1n,
  canonical: true,
});

describe("aggregateFlows", () => {
  it("separates deposits from withdrawals", () => {
    // PRD TR-F-014: a report distinguishes what entered from what left, not just the net.
    const result = aggregateFlows([deposit(1_000n), deposit(500n), withdraw(300n)]);

    expect(result.depositedAssets).toBe(1_500n);
    expect(result.withdrawnAssets).toBe(300n);
    expect(result.netFlowAssets).toBe(1_200n);
    expect(result.depositCount).toBe(2);
    expect(result.withdrawalCount).toBe(1);
  });

  it("produces a negative net flow when more left than entered", () => {
    const result = aggregateFlows([deposit(100n), withdraw(400n)]);

    expect(result.netFlowAssets).toBe(-300n);
  });

  it("excludes the share mint that accompanies a deposit", () => {
    /*
     * A deposit emits both a Deposit event and a share mint. Counting the mint would double the
     * economic movement. Task 3 promotes mints precisely so this exclusion can be demonstrated
     * rather than assumed.
     */
    const result = aggregateFlows([deposit(1_000n), transfer("mint")]);

    expect(result.depositedAssets).toBe(1_000n);
    expect(result.excluded.mints).toBe(1);
  });

  it("excludes the share burn that accompanies a withdrawal", () => {
    const result = aggregateFlows([withdraw(1_000n), transfer("burn")]);

    expect(result.withdrawnAssets).toBe(1_000n);
    expect(result.excluded.burns).toBe(1);
  });

  it("excludes wallet-to-wallet share transfers", () => {
    // Ownership moved; vault assets did not.
    const result = aggregateFlows([transfer("transfer")]);

    expect(result.netFlowAssets).toBe(0n);
    expect(result.excluded.transfers).toBe(1);
  });

  it("excludes an unclassified share movement rather than counting it", () => {
    const result = aggregateFlows([transfer("unspecified")]);

    expect(result.excluded.transfers).toBe(1);
    expect(result.netFlowAssets).toBe(0n);
  });

  it("excludes rows a deep reorg orphaned", () => {
    // Non-canonical rows stay in the table as audit state and must never reach a live calculation.
    const result = aggregateFlows([deposit(1_000n), deposit(9_999n, { canonical: false })]);

    expect(result.depositedAssets).toBe(1_000n);
    expect(result.excluded.nonCanonical).toBe(1);
  });

  it("excludes a row with no asset amount instead of reading it as zero", () => {
    // Zero would understate the flow while looking like a complete answer; the count is what tells
    // the report to label the total a lower bound.
    const result = aggregateFlows([deposit(1_000n), deposit(0n, { assets: null })]);

    expect(result.depositedAssets).toBe(1_000n);
    expect(result.depositCount).toBe(1);
    expect(result.excluded.missingAssets).toBe(1);
  });

  it("returns zeroes for an empty window without inventing anything", () => {
    const result = aggregateFlows([]);

    expect(result).toMatchObject({
      depositedAssets: 0n,
      withdrawnAssets: 0n,
      netFlowAssets: 0n,
      depositCount: 0,
      withdrawalCount: 0,
    });
  });

  it("does not double-count a full deposit-and-withdraw cycle with its share events", () => {
    const result = aggregateFlows([
      deposit(1_000n),
      transfer("mint"),
      withdraw(400n),
      transfer("burn"),
    ]);

    expect(result.netFlowAssets).toBe(600n);
    expect(result.excluded.mints + result.excluded.burns).toBe(2);
  });
});
