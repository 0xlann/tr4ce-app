import { createHash } from "node:crypto";

/**
 * Canonical serialisation and derived report identity.
 *
 * A report has to be reproducible from its persisted observations (PRD TR-F-016), which means the
 * same inputs must yield the same report — identifier included. A random id would make the
 * reproducibility fixture check nothing: two runs would differ in exactly the field a reader uses
 * to tell whether they are the same report.
 */

/**
 * JSON with object keys sorted at every depth and no incidental whitespace.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical inputs built by
 * different code paths would otherwise hash differently. `bigint` is written as a decimal string,
 * because `JSON.stringify` throws on it and any numeric coercion would defeat the point.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // undefined is absence, and absence has no canonical spelling; drop it rather than emit null.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

  return `{${entries.join(",")}}`;
}

/** SHA-256 of the canonical form, as lowercase hex. */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

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
