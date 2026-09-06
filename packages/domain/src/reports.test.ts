import { describe, expect, it } from "vitest";

import { policyRuleKeySchema, policyRuleStatusSchema } from "./policy.js";
import {
  persistedRuleStatus,
  POLICY_RULE_OPERATORS,
  reportStatusSchema,
  ruleResultStatusSchema,
} from "./reports.js";

/**
 * The wire spelling and the stored spelling of one concept.
 *
 * `policyRuleStatusSchema` is uppercase because that is the published contract; ERD section 6
 * spells the column lowercase. Two hand-maintained lists of the same three values is exactly how
 * enums drift, and `migration.test.ts` cannot catch it — that one compares SQL against zod, and
 * both of these are zod.
 */

describe("stored and wire rule statuses", () => {
  it("are the same three values in two spellings", () => {
    expect([...ruleResultStatusSchema.options].sort()).toEqual(
      [...policyRuleStatusSchema.options].map((status) => status.toLowerCase()).sort(),
    );
  });

  it("map every wire status to a stored one", () => {
    // Without this, adding a status to the wire contract leaves `persistedRuleStatus` throwing at
    // runtime with every other check still green.
    for (const status of policyRuleStatusSchema.options) {
      expect(() => persistedRuleStatus(status)).not.toThrow();
    }
  });
});

describe("report status", () => {
  it("is every rule status plus the one a report alone can have", () => {
    /*
     * `not_evaluated` is not a fourth verdict. It marks a report generated with no policy attached,
     * which is a different thing from rules that could not be decided — collapsing it into
     * `unknown` would make an evidence-only report indistinguishable from an undecided one.
     */
    expect([...reportStatusSchema.options].sort()).toEqual(
      [...ruleResultStatusSchema.options, "not_evaluated"].sort(),
    );
  });
});

describe("rule operators", () => {
  it("cover every rule key", () => {
    // A sixth rule key must not be able to reach the normalized projection without an operator.
    expect(Object.keys(POLICY_RULE_OPERATORS).sort()).toEqual(
      [...policyRuleKeySchema.options].sort(),
    );
  });
});
