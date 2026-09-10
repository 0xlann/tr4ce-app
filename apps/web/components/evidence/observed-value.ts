/**
 * Rendering what a rule observed, without pretending to know its shape.
 *
 * The evaluator formats each rule's `observedValue` for the unit that rule is about: base units for
 * an amount, `"0 bps"` for a return, `"0.23 days"` for a history window, `null` when the observation
 * was not available at all. That is a display string decided one layer down, and reformatting it
 * here means parsing a format nobody promised.
 *
 * So these helpers do the one safe thing: reformat when the value is unambiguously an integer, and
 * otherwise show exactly what the evaluator said. A wrong number is worse than an unpolished one,
 * and `NaN%` — which is what `Number("0 bps")` renders as — is worse than both.
 */

/** The leading integer of a value like `"-125 bps"`, or null when there is not one. */
export function leadingInteger(value: string | null): bigint | null {
  if (value === null) {
    return null;
  }

  const match = /^\s*(-?\d+)/.exec(value);

  return match === null ? null : BigInt(match[1]!);
}

/** True when the whole value is an integer, so a unit-aware formatter may be applied to it. */
export function isWholeInteger(value: string | null): value is string {
  return value !== null && /^\s*-?\d+\s*$/.test(value);
}

/**
 * A basis-point value as a percentage, or the evaluator's own words.
 *
 * Never zero as a fallback. "We did not observe it" and "it did not move" are different claims about
 * a vault, and only one of them can be true at a time.
 */
export function formatBasisPoints(value: string | null): { text: string; negative: boolean } | null {
  const bps = leadingInteger(value);

  if (bps === null) {
    return null;
  }

  const negative = bps < 0n;
  const whole = (bps < 0n ? -bps : bps) / 100n;
  const fraction = ((bps < 0n ? -bps : bps) % 100n).toString().padStart(2, "0");

  return { text: `${negative ? "-" : "+"}${whole}.${fraction}%`, negative };
}
