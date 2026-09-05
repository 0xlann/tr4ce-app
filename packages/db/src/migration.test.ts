import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  callStatusSchema,
  flowKindSchema,
  invalidationSubjectKindSchema,
  reasonCodeSchema,
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

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "migrations",
    "0001_registry_observations.sql",
  ),
  "utf8",
);

/** Pull the quoted values out of `CONSTRAINT <name> CHECK (… IN ('a', 'b', …))`. */
function checkConstraintValues(constraintName: string): string[] {
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
  const cases: [string, readonly string[]][] = [
    ["vault_status_check", vaultStatusSchema.options],
    ["vault_flow_kind_check", flowKindSchema.options],
    ["vault_flow_transfer_kind_check", transferKindSchema.options],
    ["vault_snapshot_call_status_check", callStatusSchema.options],
    ["reorg_invalidation_subject_kind_check", invalidationSubjectKindSchema.options],
    ["reorg_invalidation_reason_code_check", reasonCodeSchema.options],
  ];

  for (const [constraint, options] of cases) {
    it(`${constraint} lists exactly the shared values`, () => {
      // Sorted: the SQL is laid out for readability, the enum for meaning. Order is not the claim.
      expect(checkConstraintValues(constraint).sort()).toEqual([...options].sort());
    });
  }
});

describe("integrity rules a schema differ cannot infer", () => {
  it("keeps every observation on the same chain as its vault", () => {
    // Without these, an application bug could attribute one vault's flow to another vault, and the
    // resulting report would be wrong in a way no test of the calculation would catch.
    expect(migration).toContain(
      "FOREIGN KEY (vault_id, chain_id) REFERENCES vault (id, chain_id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (capability_id, vault_id) REFERENCES vault_capability (id, vault_id)",
    );
  });

  it("keeps a report's citations on the report's own vault", () => {
    expect(migration).toContain(
      "FOREIGN KEY (report_id, vault_id) REFERENCES evidence_report (id, vault_id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (vault_flow_id, vault_id) REFERENCES vault_flow (id, vault_id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (vault_snapshot_id, vault_id) REFERENCES vault_snapshot (id, vault_id)",
    );
  });

  it("allows only one open capability profile per vault", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS vault_capability_open_key\s+ON vault_capability \(vault_id\) WHERE effective_to_block IS NULL;/,
    );
  });

  it("rejects a report citing a non-canonical observation at creation time", () => {
    expect(migration).toContain("CREATE TRIGGER report_observation_canonical_trigger");
    expect(migration).toContain("BEFORE INSERT ON report_observation");
  });

  it("counts NULL observation columns as equal when deduplicating citations", () => {
    // Under the default NULLS DISTINCT every row with a NULL column looks unique, so a repeated
    // citation would slip past the unique index entirely.
    expect(migration).toContain("NULLS NOT DISTINCT");
  });

  it("never allows a snapshot that no trigger explains", () => {
    expect(migration).toContain("CHECK (trigger_activity OR trigger_checkpoint OR trigger_anchor)");
  });

  it("requires a share transfer to carry its classification and other kinds not to", () => {
    expect(migration).toContain("CHECK ((kind = 'share_transfer') = (transfer_kind IS NOT NULL))");
  });

  it("ties a non-ok call status to a non-empty call_errors array", () => {
    expect(migration).toContain("CHECK ((call_status = 'ok') = (jsonb_array_length(call_errors) = 0))");
  });
});

describe("nullability of read results", () => {
  it("leaves every snapshot amount nullable", () => {
    // NULL means the call produced no usable value. A NOT NULL here would force the promotion
    // worker to invent a zero, which is the single most dangerous thing this pipeline could do:
    // a fabricated zero totalAssets reads as a vault that lost all its deposits.
    for (const column of ["total_assets", "total_supply", "one_share_assets"]) {
      expect(migration).toMatch(new RegExp(`${column}\\s+NUMERIC\\(78,0\\)(?!\\s+NOT NULL)`));
    }
  });

  it("keeps flow assets nullable, since a share transfer moves none", () => {
    expect(migration).toMatch(/assets\s+NUMERIC\(78,0\),/);
  });
});
