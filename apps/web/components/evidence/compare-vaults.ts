import type { VaultSummary } from "../../src/demo/types";

const statusRank = { PASS: 0, FAIL: 1, UNKNOWN: 2 } as const;

export function compareVaults(vaults: readonly VaultSummary[]): VaultSummary[] {
  return [...vaults].sort((left, right) => {
    const statusDifference = statusRank[left.report.policy.status] - statusRank[right.report.policy.status];
    if (statusDifference !== 0) return statusDifference;

    const completenessDifference = right.completeness - left.completeness;
    if (completenessDifference !== 0) return completenessDifference;

    return left.name.localeCompare(right.name);
  });
}
