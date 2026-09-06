import { createHash } from "node:crypto";

/**
 * Canonical serialisation.
 *
 * Lives in the domain because more than one layer hashes structured values and every one of them
 * has to agree byte for byte: @tr4ce/evidence derives a report's identity from its observations
 * (PRD TR-F-016), and @tr4ce/db derives a policy version's content hash the same way. Two
 * implementations of "the canonical form" would mean two answers to "is this the same thing".
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

