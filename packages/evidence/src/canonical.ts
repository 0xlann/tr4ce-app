import { canonicalDigest } from "@tr4ce/domain";

/**
 * Derived report identity.
 *
 * The serialisation this rests on lives in @tr4ce/domain, because the persistence layer hashes
 * policy content with the same function and the two must agree byte for byte.
 */

export { canonicalDigest, canonicalJson } from "@tr4ce/domain";

/**
 * Hash the observations a report was built from.
 *
 * The full 64-hex digest, which is what `evidence_report.canonical_input_hash` stores and what the
 * unique index on `(canonical_input_hash, calculation_version, schema_version)` deduplicates on
 * (ERD section 6).
 *
 * What goes in is the caller's decision, and it is a load-bearing one: the input must describe what
 * was *observed*, never when it was rendered. `buildEvidence` is where that boundary is drawn.
 */
export function canonicalInputHash(input: unknown): string {
  return canonicalDigest(input);
}

/**
 * The public identifier for a set of observations.
 *
 * Derived from the hash rather than generated, so two requests over identical observations name the
 * same report without consulting the database first — the property Task 6's acceptance clause
 * ("repeating a request over identical inputs returns the same report") rests on.
 *
 * `evidenceReportV1Schema` constrains this to `^trc_[A-Za-z0-9]+$`, so hyphens are illegal and a
 * formatted UUID cannot be used; the digest goes in as bare hex. Truncated to 32 characters, which
 * is far past any collision concern for a per-vault report set and keeps the id readable in a URL.
 */
export function reportIdFor(hash: string): string {
  return `trc_${hash.slice(0, 32)}`;
}

/** Both identities for one set of observations, derived from a single digest. */
export function deriveReportIdentity(input: unknown): {
  canonicalInputHash: string;
  reportId: string;
} {
  const hash = canonicalInputHash(input);

  return { canonicalInputHash: hash, reportId: reportIdFor(hash) };
}
