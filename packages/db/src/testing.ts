import postgres from "postgres";

/**
 * Test-only database provisioning.
 *
 * Integration suites rebuild the schema from scratch, so two of them sharing one database means one
 * drops the schema out from under the other — which turbo will happily arrange, since it runs
 * package tasks in parallel. Each suite therefore gets its own database, derived from the base URL
 * by name.
 *
 * Not used by any runtime path. It lives in the package because both @tr4ce/db and @tr4ce/worker
 * need it and it has to agree with them about how the schema is built.
 */

/**
 * Drop and recreate `<database>_<suite>`, returning a URL pointing at it.
 *
 * `WITH (FORCE)` terminates leftover connections from an interrupted run rather than failing on
 * them, so a killed test process does not wedge the next one.
 */
export async function provisionTestDatabase(baseUrl: string, suite: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(suite)) {
    throw new Error(`Suite name must be a bare identifier, received ${JSON.stringify(suite)}.`);
  }

  const target = new URL(baseUrl);
  const name = `${target.pathname.replace(/^\//, "")}_${suite}`;

  const maintenance = new URL(baseUrl);
  maintenance.pathname = "/postgres";

  const client = postgres(maintenance.toString(), { max: 1, prepare: false });

  try {
    await client.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end({ timeout: 5 });
  }

  target.pathname = `/${name}`;

  return target.toString();
}
