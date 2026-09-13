/**
 * Reduced rational arithmetic over `bigint`.
 *
 * Every ratio the evidence engine produces keeps its numerator and denominator (PRD TR-F-013):
 * formatting is a presentation concern, and a ratio that has already been collapsed into a single
 * number cannot be re-derived or audited. Nothing here converts to `number` except the explicit
 * basis-point step at the end, which is an integer by definition.
 */

/** Greatest common divisor, always non-negative. */
export function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;

  while (b !== 0n) {
    [a, b] = [b, a % b];
  }

  return a;
}

export interface Rational {
  numerator: bigint;
  /** Always strictly positive after reduction; sign lives entirely in the numerator. */
  denominator: bigint;
}

/**
 * Reduce a ratio to lowest terms with a positive denominator.
 *
 * Normalising the sign onto the numerator is what makes comparison and rounding predictable: with
 * a negative denominator, `floor` would silently flip direction.
 */
export function reduce(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new RangeError("Refusing to build a rational with a zero denominator.");
  }

  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  const divisor = gcd(signedNumerator, positiveDenominator);

  if (divisor === 0n) {
    return { numerator: 0n, denominator: 1n };
  }

  return { numerator: signedNumerator / divisor, denominator: positiveDenominator / divisor };
}

/** `-1`, `0`, or `1`. Cross-multiplied, so no division and no precision loss. */
export function compare(left: Rational, right: Rational): -1 | 0 | 1 {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;

  if (difference < 0n) {
    return -1;
  }

  return difference > 0n ? 1 : 0;
}

/**
 * Integer division rounding toward negative infinity.
 *
 * `BigInt` division truncates toward zero, which rounds *up* for negative values. That difference
 * is invisible on gains and decisive on losses, so it gets its own function rather than living
 * inline at a call site where the next reader assumes the default.
 */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("Division by zero.");
  }

  const quotient = numerator / denominator;

  // Truncation already matched floor unless the true result was negative and inexact.
  const roundedUp = numerator % denominator !== 0n && numerator < 0n !== denominator < 0n;

  return roundedUp ? quotient - 1n : quotient;
}

export const BASIS_POINTS_SCALE = 10_000n;

export interface BasisPointsResult {
  numerator: bigint;
  denominator: bigint;
  /** Always `"floor"` in this engine; carried so a report states its own rounding (TR-F-013). */
  rounding: "floor";
  value: number;
}

/**
 * Convert a ratio to basis points, rounding down.
 *
 * Down, not toward zero, and the choice is load-bearing: the `minObservedReturnBps` policy rule
 * asks whether a return cleared a threshold. Rounding in any direction that can move a value *up*
 * would let a vault pass that rule on rounding alone. Flooring can only ever understate a return,
 * which fails safe.
 *
 * The result is a `number` because a basis point is an integer count, not a token amount — the one
 * place in this package where leaving `bigint` is correct. It is range-checked so a pathological
 * ratio cannot silently exceed what a `number` represents exactly.
 */
export function toBasisPoints(ratio: Rational): BasisPointsResult {
  const scaled = floorDiv(ratio.numerator * BASIS_POINTS_SCALE, ratio.denominator);

  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(
      `Basis-point result ${scaled} falls outside the exactly-representable integer range.`,
    );
  }

  return {
    numerator: ratio.numerator,
    denominator: ratio.denominator,
    rounding: "floor",
    value: Number(scaled),
  };
}
