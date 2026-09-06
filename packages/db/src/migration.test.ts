import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  callStatusSchema,
  flowKindSchema,
  invalidationSubjectKindSchema,
  observationPurposeSchema,
  observationTypeSchema,
  policyRuleKeySchema,
  policyRuleOperatorSchema,
  policySourceSchema,
  reasonCodeSchema,
  reportStatusSchema,
  ruleResultStatusSchema,
  transferKindSchema,
  vaultStatusSchema,
} from "@tr4ce/domain";
import { describe, expect, it } from "vitest";

/**
 * ERD section 11: "All enum-like text columns have database CHECK constraints generated from
 * shared schema values."
 *
 * The migration is hand-written SQL, so "generated from" is enforced here rather than by a code
 * generator: every enum CHECK list has to match the zod options exactly. Widening an enum in
 * @tr4ce/domain without widening the constraint fails this test at build time, instead of failing
 * an INSERT in production months later — which is the failure mode the ERD clause exists to
 * prevent.
 */

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const read = (file: string) => readFileSync(join(migrationsDirectory, file), "utf8");

/*
 * Read per file rather than as one concatenated blob.
 *
 * 0002 drops and recreates `evidence_report` and `report_observation`, so 0001 still contains their
 * superseded definitions. A search across both files would happily match that dead text and report
 * a constraint as present after it had been dropped — the assertion would pass while testing
 * nothing. Each table is therefore checked against the migration that currently owns it.
 */
const registry = read("0001_registry_observations.sql");
const reports = read("0002_reports_and_policies.sql");

/** Pull the quoted values out of `CONSTRAINT <name> CHECK (… IN ('a', 'b', …))`. */
function checkConstraintValues(migration: string, constraintName: string): string[] {
  // Whitespace-tolerant: a long IN list is wrapped onto the next line in the migration.
  const declaration = new RegExp(`CONSTRAINT\\s+${constraintName}\\b`).exec(migration);

  if (declaration === null) {
    throw new Error(`Migration has no constraint named ${constraintName}.`);
  }

  const start = declaration.index;

  // Walk the parenthesised body so a multi-line IN list is captured whole.
  const open = migration.indexOf("(", migration.indexOf("CHECK", start));
  let depth = 0;
  let end = open;

  for (; end < migration.length; end += 1) {
    if (migration[end] === "(") {
      depth += 1;
    } else if (migration[end] === ")") {
      depth -= 1;

      if (depth === 0) {
        break;
      }
    }
  }

  const body = migration.slice(open, end + 1);

  return [...body.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

describe("enum CHECK constraints match the shared schema", () => {
  const cases: [string, string, readonly string[]][] = [
    [registry, "vault_status_check", vaultStatusSchema.options],
    [registry, "vault_flow_kind_check", flowKindSchema.options],
    [registry, "vault_flow_transfer_kind_check", transferKindSchema.options],
    [registry, "vault_snapshot_call_status_check", callStatusSchema.options],
    [registry, "reorg_invalidation_subject_kind_check", invalidationSubjectKindSchema.options],
    [registry, "reorg_invalidation_reason_code_check", reasonCodeSchema.options],
    [reports, "policy_version_source_check", policySourceSchema.options],
    [reports, "policy_rule_key_check", policyRuleKeySchema.options],
    [reports, "policy_rule_operator_check", policyRuleOperatorSchema.options],
    [reports, "evidence_report_status_check", reportStatusSchema.options],
    [reports, "rpc_observation_call_status_check", callStatusSchema.options],
    [reports, "report_observation_type_check", observationTypeSchema.options],
    [reports, "report_observation_purpose_check", observationPurposeSchema.options],
    [reports, "rule_result_status_check", ruleResultStatusSchema.options],
  ];

  for (const [migration, constraint, options] of cases) {
    it(`${constraint} lists exactly the shared values`, () => {
      // Sorted: the SQL is laid out for readability, the enum for meaning. Order is not the claim.
      expect(checkConstraintValues(migration, constraint).sort()).toEqual([...options].sort());
    });
  }
});

describe("integrity rules a schema differ cannot infer", () => {
  it("keeps every observation on the same chain as its vault", () => {
    // Without these, an application bug could attribute one vault's flow to another vault, and the
    // resulting report would be wrong in a way no test of the calculation would catch.
    expect(registry).toContain(
      "FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id)",
    );
    expect(registry).toContain(
      "FOREIGN KEY (capability_id, vault_id) REFERENCES vault_capability (id, vault_id)",
    );
  });

  it("keeps a report's citations on the report's own vault", () => {
    expect(reports).toContain(
      "FOREIGN KEY (report_id, vault_id) REFERENCES evidence_report (id, vault_id)",
    );
    expect(reports).toContain(
      "FOREIGN KEY (vault_flow_id, vault_id) REFERENCES vault_flow (id, vault_id)",
    );
    expect(reports).toContain(
      "FOREIGN KEY (vault_snapshot_id, vault_id) REFERENCES vault_snapshot (id, vault_id)",
    );
  });

  it("keeps a rule result on a rule from the version the report was judged against", () => {
    // Without it a report could carry a verdict for a rule belonging to some other policy version,
    // and the stored evaluation would no longer be re-derivable from the stored policy.
    expect(reports).toContain("FOREIGN KEY (policy_rule_id, policy_version_id)");
  });

  it("ties a report's verdict to whether a policy was attached at all", () => {
    // not_evaluated means "no policy asked", not "the rules could not be decided". Letting the two
    // drift apart would make an evidence-only report indistinguishable from an undecided one.
    expect(reports).toContain("CHECK ((policy_version_id IS NULL) = (status = 'not_evaluated'))");
  });

  it("makes a citation's declared type agree with the column it populates", () => {
    expect(reports).toContain(
      "CHECK (num_nonnulls(vault_flow_id, vault_snapshot_id, rpc_observation_id) = 1)",
    );
    expect(reports).toContain("CONSTRAINT report_observation_type_matches_check");
  });

  it("deduplicates equivalent reports on their canonical input", () => {
    // ERD section 6. This is the constraint the API's idempotency rests on, enforced by the
    // database rather than by a lookup the application could forget to perform.
    expect(reports).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS evidence_report_input_key\s+ON evidence_report \(canonical_input_hash, calculation_version, schema_version\);/,
    );
  });

  it("drops dependents before the table they reference", () => {
    // migrate.ts replays a file that was applied but never recorded, so 0002 has to survive being
    // run twice against the same database. Without rule_result in the drop list the replay fails
    // on "other objects depend on it" — which is how this line came to exist.
    const order = ["rule_result", "report_observation", "evidence_report"].map((table) =>
      reports.indexOf(`DROP TABLE IF EXISTS ${table};`),
    );

    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    // CASCADE would do it in one line and would also drop anything added later without saying so.
    // Matched with comments stripped, since the prose above those DROPs explains that very choice.
    expect(reports.replaceAll(/--[^\n]*/g, "")).not.toContain("CASCADE");
  });

  it("widens the reorg audit subject so a report id fits", () => {
    // evidence_report.id stopped being a UUID in this migration. reorg_invalidation names its
    // subject across three tables, and ERD section 11 lists evidence_report among them, so leaving
    // the column as uuid would make an invalidated report unrecordable.
    expect(reports).toContain("ALTER TABLE reorg_invalidation ALTER COLUMN subject_id TYPE TEXT");
  });

  it("refuses to drop report tables that hold rows", () => {
    // 0002 rewrites two tables that have only ever been empty. The guard is what keeps that a fact
    // about this database rather than an assumption about every database.
    expect(reports).toContain("EXISTS (SELECT 1 FROM evidence_report)");
    expect(reports).toContain("holds rows; 0002 will not drop it");
  });

  it("stores a provider key on an RPC observation and never a credential", () => {
    // ERD section 6 states this outright. Matched against the DDL with comments stripped, since the
    // prose above these columns necessarily uses the very words the check is looking for.
    const ddl = reports.replaceAll(/--[^\n]*/g, "");

    expect(ddl).toMatch(/provider_key\s+TEXT\s+NOT NULL/);
    expect(ddl).not.toMatch(/rpc_url|api_key|secret|credential/i);
  });

  it("allows only one open capability profile per vault", () => {
    expect(registry).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS vault_capability_open_key\s+ON vault_capability \(vault_id\) WHERE effective_to_block IS NULL;/,
    );
  });

  it("rejects a report citing a non-canonical observation at creation time", () => {
    // Checked against 0002, which owns the table now. Against 0001 this would still pass on the
    // definition 0002 dropped.
    expect(reports).toContain("CREATE TRIGGER report_observation_canonical_trigger");
    expect(reports).toContain("BEFORE INSERT ON report_observation");
  });

  it("counts NULL observation columns as equal when deduplicating citations", () => {
    // Under the default NULLS DISTINCT every row with a NULL column looks unique, so a repeated
    // citation would slip past the unique index entirely.
    expect(reports).toContain("NULLS NOT DISTINCT");
  });

  it("never allows a snapshot that no trigger explains", () => {
    expect(registry).toContain("CHECK (trigger_activity OR trigger_checkpoint OR trigger_anchor)");
  });

  it("requires a share transfer to carry its classification and other kinds not to", () => {
    expect(registry).toContain("CHECK ((kind = 'share_transfer') = (transfer_kind IS NOT NULL))");
  });

  it("ties a non-ok call status to a non-empty call_errors array", () => {
    expect(registry).toContain("CHECK ((call_status = 'ok') = (jsonb_array_length(call_errors) = 0))");
  });
});

describe("nullability of read results", () => {
  it("leaves every snapshot amount nullable", () => {
    // NULL means the call produced no usable value. A NOT NULL here would force the promotion
    // worker to invent a zero, which is the single most dangerous thing this pipeline could do:
    // a fabricated zero totalAssets reads as a vault that lost all its deposits.
    for (const column of ["total_assets", "total_supply", "one_share_assets"]) {
      expect(registry).toMatch(new RegExp(`${column}\\s+NUMERIC\\(78,0\\)(?!\\s+NOT NULL)`));
    }
  });

  it("keeps flow assets nullable, since a share transfer moves none", () => {
    expect(registry).toMatch(/assets\s+NUMERIC\(78,0\),/);
  });

  it("leaves an RPC observation free to have produced nothing", () => {
    // Same rule one layer out: a reverted call has no return value, and a NOT NULL here would push
    // someone into storing empty bytes as though the chain had answered.
    expect(reports).toMatch(/raw_result\s+BYTEA,/);
    expect(reports).toMatch(/revert_data\s+BYTEA,/);
  });
});
