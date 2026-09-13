import { describe, expect, it } from "vitest";

import { formatBasisPoints, isWholeInteger, leadingInteger } from "./observed-value.js";

/**
 * The evaluator's own formats, taken from a live response rather than imagined:
 * `"0 bps"`, `"0.23 days"`, `"417512900099011"`, `null`.
 */

describe("leadingInteger", () => {
  it("reads the number out of a value that carries its unit", () => {
    expect(leadingInteger("0 bps")).toBe(0n);
    expect(leadingInteger("-125 bps")).toBe(-125n);
  });

  it("returns null rather than zero when nothing was observed", () => {
    // The distinction the whole product rests on: no observation is not a zero observation.
    expect(leadingInteger(null)).toBeNull();
  });

  it("refuses a value that does not start with a number", () => {
    expect(leadingInteger("USDC")).toBeNull();
  });
});

describe("isWholeInteger", () => {
  it("accepts a raw base-unit amount", () => {
    expect(isWholeInteger("417512900099011")).toBe(true);
  });

  it("rejects a value carrying a unit or a fraction", () => {
    // "0.23 days" must not be reformatted as USDC, which is what a looser test would allow.
    expect(isWholeInteger("0.23 days")).toBe(false);
    expect(isWholeInteger("0 bps")).toBe(false);
    expect(isWholeInteger(null)).toBe(false);
  });
});

describe("formatBasisPoints", () => {
  it("renders hundredths of a percent without floating point", () => {
    expect(formatBasisPoints("125 bps")?.text).toBe("+1.25%");
    expect(formatBasisPoints("7 bps")?.text).toBe("+0.07%");
    expect(formatBasisPoints("0 bps")?.text).toBe("+0.00%");
  });

  it("keeps a negative return negative", () => {
    const negative = formatBasisPoints("-50 bps");

    expect(negative?.text).toBe("-0.50%");
    expect(negative?.negative).toBe(true);
  });

  it("is null when the return was not observed", () => {
    expect(formatBasisPoints(null)).toBeNull();
  });
});
