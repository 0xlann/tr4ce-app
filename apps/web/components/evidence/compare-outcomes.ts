import type { EvaluationOutcome } from "../../src/api/evaluation";
import type { VaultRow } from "./vault-row";

/**
 * Ordering the comparison so a verdict never loses to a number.
 *
 * PASS, then FAIL, then UNKNOWN, then vaults with no verdict at all. Within a status, the vault
 * whose evidence was more complete comes first — a PASS drawn from five observed rules is a stronger
 * answer than a PASS drawn from three, and putting them in one bucket would hide that.
 *
 * Nothing here sorts by return. The acceptance clause for this task is that no yield headline
 * outranks policy status, and the only way to keep that true is for return never to enter the
 * comparator at all.
 */

const statusRank = { PASS: 0, FAIL: 1, UNKNOWN: 2 } as const;

export type ComparedRow = { vault: VaultRow; outcome: EvaluationOutcome };

export function compareOutcomes(
  vaults: readonly VaultRow[],
  outcomes: readonly EvaluationOutcome[],
): ComparedRow[] {
  const rows: ComparedRow[] = [];

  for (const outcome of outcomes) {
    const vault = vaults.find(
      (candidate) => candidate.address.toLowerCase() === outcome.vaultAddress.toLowerCase(),
    );

    if (vault !== undefined) {
      rows.push({ vault, outcome });
    }
  }

  return rows.sort((left, right) => {
    const statusDifference = rank(left.outcome) - rank(right.outcome);
    if (statusDifference !== 0) return statusDifference;

    const completenessDifference = completeness(right.outcome) - completeness(left.outcome);
    if (completenessDifference !== 0) return completenessDifference;

    return name(left).localeCompare(name(right));
  });
}

/** A vault the evaluator could not answer for sorts last: it is the least useful row, not the worst. */
function rank(outcome: EvaluationOutcome): number {
  return outcome.status === null ? 3 : statusRank[outcome.status];
}

/** How many of the five rules reached an observation, rather than reporting none. */
export function completeness(outcome: EvaluationOutcome): number {
  if (outcome.rules === null) {
    return 0;
  }

  return outcome.rules.filter((rule) => rule.status !== "UNKNOWN").length;
}

function name(row: ComparedRow): string {
  return row.vault.name ?? row.vault.symbol ?? row.vault.address;
}
