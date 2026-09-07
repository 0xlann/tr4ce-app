import { describe, expect, it } from "vitest";

import { isManagedHost, provisionTestDatabase } from "./testing.js";

/**
 * The guard on `provisionTestDatabase`.
 *
 * Its first act is `DROP DATABASE ... WITH (FORCE)`. A copied line in a shell, or a `.env` shared
 * between machines, is all it takes to point that at a deployed project — so the refusal is tested
 * rather than trusted.
 *
 * The rule is tested through the pure predicate. Asserting the negative case through
 * `provisionTestDatabase` itself would mean waiting on a connection to a host that does not exist,
 * which is a timeout dressed up as a test.
 */

describe("isManagedHost", () => {
  const hosted = [
    "postgres://u:p@db.abcdefghijkl.supabase.co:5432/postgres",
    "postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
    "postgres://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/main",
    "postgres://u:p@instance.abc.eu-west-1.rds.amazonaws.com:5432/app",
    "postgres://u:p@dpg-abc123.oregon-postgres.render.com/app",
  ];

  for (const url of hosted) {
    it(`recognises ${new URL(url).hostname}`, () => {
      expect(isManagedHost(url)).toBe(true);
    });
  }

  const local = [
    "postgres://tr4ce:tr4ce@localhost:5432/tr4ce_test",
    "postgres://tr4ce:tr4ce@127.0.0.1:5432/tr4ce_test",
    "postgres://tr4ce:tr4ce@postgres:5432/tr4ce_test",
    // Contains a provider name without being one. A substring match would refuse it, and a guard
    // people have to work around is a guard they will remove.
    "postgres://tr4ce:tr4ce@supabase.local:5432/tr4ce_test",
    "postgres://tr4ce:tr4ce@my-supabase-clone.internal:5432/tr4ce_test",
  ];

  for (const url of local) {
    it(`leaves ${new URL(url).hostname} alone`, () => {
      expect(isManagedHost(url)).toBe(false);
    });
  }
});

describe("provisionTestDatabase", () => {
  it("refuses a hosted database before opening a connection", async () => {
    await expect(
      provisionTestDatabase("postgres://u:p@db.x.supabase.co:5432/postgres", "observations"),
    ).rejects.toThrow(/hosted database/);
  });

  it("names the local alternative rather than only refusing", async () => {
    // A refusal that does not say what to do instead just relocates the confusion.
    await expect(
      provisionTestDatabase("postgres://u:p@db.x.supabase.co:5432/postgres", "api"),
    ).rejects.toThrow(/docker compose up -d postgres/);
  });
});
