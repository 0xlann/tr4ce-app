import { describe, expect, it } from "vitest";

import { compare, floorDiv, gcd, reduce, toBasisPoints } from "./rational.js";

describe("gcd", () => {
  it("is sign-independent", () => {
    expect(gcd(-12n, 18n)).toBe(6n);
    expect(gcd(12n, -18n)).toBe(6n);
    expect(gcd(-12n, -18n)).toBe(6n);
  });

  it("treats zero as the identity", () => {
    expect(gcd(0n, 7n)).toBe(7n);
    expect(gcd(7n, 0n)).toBe(7n);
  });
});

describe("reduce", () => {
  it("reduces to lowest terms", () => {
    expect(reduce(50n, 100n)).toEqual({ numerator: 1n, denominator: 2n });
  });

  it("moves the sign onto the numerator", () => {
    // With a negative denominator left in place, floor rounding would run the wrong way.
    expect(reduce(1n, -2n)).toEqual({ numerator: -1n, denominator: 2n });
    expect(reduce(-1n, -2n)).toEqual({ numerator: 1n, denominator: 2n });
  });

  it("normalises zero", () => {
    expect(reduce(0n, 5n)).toEqual({ numerator: 0n, denominator: 1n });
  });

  it("refuses a zero denominator instead of returning infinity", () => {
    expect(() => reduce(1n, 0n)).toThrow(RangeError);
  });

  it("handles uint256-scale values without loss", () => {
    const huge = 2n ** 255n;

    expect(reduce(huge * 3n, huge * 6n)).toEqual({ numerator: 1n, denominator: 2n });
  });
});

describe("compare", () => {
  it("orders by cross-multiplication, not by division", () => {
    // 1/3 vs 2/7: division in floating point makes these nearly indistinguishable.
    expect(compare({ numerator: 1n, denominator: 3n }, { numerator: 2n, denominator: 7n })).toBe(1);
    expect(compare({ numerator: 2n, denominator: 7n }, { numerator: 1n, denominator: 3n })).toBe(-1);
    expect(compare({ numerator: 1n, denominator: 2n }, { numerator: 2n, denominator: 4n })).toBe(0);
  });
});

describe("floorDiv", () => {
  it("matches truncation for exact and positive results", () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(6n, 2n)).toBe(3n);
  });

  it("rounds negative results down, not toward zero", () => {
    // BigInt's own `/` yields -3n here. That difference is the whole reason this function exists.
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(-7n / 2n).toBe(-3n);
  });

  it("rounds down with a negative divisor too", () => {
    expect(floorDiv(7n, -2n)).toBe(-4n);
  });

  it("leaves exact negative division alone", () => {
    expect(floorDiv(-6n, 2n)).toBe(-3n);
  });

  it("refuses division by zero", () => {
    expect(() => floorDiv(1n, 0n)).toThrow(RangeError);
  });
});

describe("toBasisPoints", () => {
  it("converts a simple gain", () => {
    // 1% = 100 bps
    expect(toBasisPoints({ numerator: 1n, denominator: 100n }).value).toBe(100);
  });

  it("rounds a gain down", () => {
    // 1/10001 is just under 1 bp and must not be presented as 1.
    expect(toBasisPoints({ numerator: 1n, denominator: 10_001n }).value).toBe(0);
  });

  it("rounds a loss down, away from zero", () => {
    /*
     * The case that separates floor from truncate-toward-zero. A -0.995 bp return truncates to 0
     * and floors to -1. Truncation would let a vault that lost value report a flat 0 and clear a
     * "return >= 0" policy rule on rounding alone.
     */
    expect(toBasisPoints({ numerator: -1n, denominator: 10_001n }).value).toBe(-1);
  });

  it("never rounds a return upward", () => {
    // The bound is checked in bigint: computing the expected value in floating point would make
    // the oracle less exact than the code it is meant to police.
    for (const numerator of [-9999n, -5000n, -3n, -1n, 1n, 3n, 5000n, 9999n]) {
      const denominator = 10_000n;
      const result = toBasisPoints({ numerator, denominator });

      expect(BigInt(result.value) * denominator).toBeLessThanOrEqual(numerator * 10_000n);
    }
  });

  it("reports its own rounding direction and keeps the ratio", () => {
    // PRD TR-F-013: numerator, denominator, rounding direction and formatted value all exposed.
    const result = toBasisPoints({ numerator: 3n, denominator: 400n });

    expect(result).toEqual({ numerator: 3n, denominator: 400n, rounding: "floor", value: 75 });
  });

  it("refuses a result outside the exactly-representable integer range", () => {
    // Better to fail loudly than to hand back a basis-point count that silently lost precision.
    expect(() => toBasisPoints({ numerator: 2n ** 80n, denominator: 1n })).toThrow(RangeError);
  });

  it("stays exact across bounded bigint ranges", () => {
    // Property sweep: the floored bps must always be the largest integer at or below the true value.
    for (let start = 1n; start <= 200n; start += 7n) {
      for (let end = 1n; end <= 200n; end += 3n) {
        const ratio = reduce(end - start, start);
        const bps = toBasisPoints(ratio).value;

        expect(BigInt(bps) * ratio.denominator).toBeLessThanOrEqual(ratio.numerator * 10_000n);
        expect((BigInt(bps) + 1n) * ratio.denominator).toBeGreaterThan(ratio.numerator * 10_000n);
      }
    }
  });
});
