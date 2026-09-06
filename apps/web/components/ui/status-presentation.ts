import type { PolicyRuleStatus } from "@tr4ce/domain";

export function statusPresentation(status: PolicyRuleStatus): { icon: string; label: PolicyRuleStatus } {
  switch (status) {
    case "PASS":
      return { icon: "✓", label: "PASS" };
    case "FAIL":
      return { icon: "×", label: "FAIL" };
    case "UNKNOWN":
      return { icon: "?", label: "UNKNOWN" };
  }
}
