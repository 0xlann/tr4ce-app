import { describe, expect, it } from "vitest";

import { observedShareValueReturn, observeShareValue } from "./share-value.js";

/**
 * Observed share-value return — PRD section 3.
 *
 * Values are quoted the way the chain reports them: one whole share converts to some number of
 * asset base units, and the return is how that figure moved. USDC has 6 decimals, so 1_000_000
 * base units is 1.00 USDC per share.
 */
describe("observedShareValueReturn", () => {
  it("computes a positive return", () => {
    // 1.041000 -> 1.052300 USDC per share, a 1.0855...% gain.
    const result = observedShareValueReturn(1_041_000n, 1_052_300n);

    expect(result.bps).toBe(108);
    expect(result.numerator).toBe(113n);
    expect(result.denominator).toBe(10_410n);
  });

  it("computes a negative return", () => {
    const result = observedShareValueReturn(1_000_000n, 990_000n);

    expect(result.bps).toBe(-100);
  });

  it("computes a flat return as exactly zero", () => {
    const result = observedShareValueReturn(1_000_000n, 1_000_000n);

    expect(result.bps).toBe(0);
    expect(result.numerator).toBe(0n);
  });

  it("rounds a gain down at the boundary", () => {
    // A hair under 1 bp must not be presented as 1 bp.
    const result = observedShareValueReturn(10_001_000n, 10_002_000n);

    expect(result.bps).toBe(0);
  });

  it("rounds a loss down at the boundary", () => {
    // A hair better than -1 bp still reports -1: rounding may never flatter a loss.
    const result = observedShareValueReturn(10_001_000n, 10_000_000n);

    expect(result.bps).toBe(-1);
  });

  it("handles 18-decimal share units without loss", () => {
    const start = 1_000_000_000_000_000_000n;
    const end = 1_100_000_000_000_000_000n;

    expect(observedShareValueReturn(start, end).bps).toBe(1_000);
  });

  it("refuses a zero start rather than dividing by it", () => {
    expect(() => observedShareValueReturn(0n, 1_000_000n)).toThrow(RangeError);
  });
});

describe("observeShareValue", () => {
  it("returns the computed value when both observations are usable", () => {
    const result = observeShareValue(1_000_000n, 1_010_000n);

    expect(result.ok).toBe(true);
    expect(result.ok && result.return.value).toBe(100);
  });

  it("reports a missing start as MISSING_OBSERVATION", () => {
    const result = observeShareValue(null, 1_000_000n);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure).toEqual({
      kind: "missing_start",
      reasonCode: "MISSING_OBSERVATION",
    });
  });

  it("reports a missing end as MISSING_OBSERVATION", () => {
    const result = observeShareValue(1_000_000n, null);

    expect(!result.ok && result.failure.kind).toBe("missing_end");
  });

  it("distinguishes an unusable zero start from an absent one", () => {
    /*
     * Both are "no return available", but they are different facts and a report has to be able to
     * say which. Collapsing them into one code makes "we never indexed that far back" and "the
     * contract told us a share was worth nothing" indistinguishable to a reader.
     */
    const absent = observeShareValue(null, 1_000_000n);
    const unusable = observeShareValue(0n, 1_000_000n);

    expect(!absent.ok && absent.failure.reasonCode).toBe("MISSING_OBSERVATION");
    expect(!unusable.ok && unusable.failure.reasonCode).toBe("AMBIGUOUS_CAPABILITY");
    expect(!absent.ok && !unusable.ok && absent.failure.reasonCode).not.toBe(
      unusable.failure.reasonCode,
    );
  });

  it("never computes a return from a null treated as zero", () => {
    // The failure mode this whole path exists to prevent: a null start silently becoming 0n would
    // produce an enormous fabricated gain instead of an honest unknown.
    const result = observeShareValue(null, 5_000_000n);

    expect(result.ok).toBe(false);
  });

  it("allows a genuine zero end value", () => {
    // A vault whose share really is worth nothing is a -100% return, not an error.
    const result = observeShareValue(1_000_000n, 0n);

    expect(result.ok).toBe(true);
    expect(result.ok && result.return.value).toBe(-10_000);
  });
});
