import type { EvidenceReportV1, PolicyV1, PreparedActionV1 } from "@tr4ce/domain";

export type PolicyPreset = "strict" | "balanced" | "lenient";

export type VaultSummary = {
  id: string;
  name: string;
  protocol: string;
  network: string;
  address: string;
  completeness: number;
  report: EvidenceReportV1;
};

export type DemoData = {
  policy: PolicyV1;
  vaults: readonly VaultSummary[];
  actions: Readonly<Record<string, PreparedActionV1>>;
};
