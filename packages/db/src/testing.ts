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
 *
 * Local databases only — see `refuseManagedHost`.
 */
export async function provisionTestDatabase(baseUrl: string, suite: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(suite)) {
    throw new Error(`Suite name must be a bare identifier, received ${JSON.stringify(suite)}.`);
  }

  refuseManagedHost(baseUrl);

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

/** Hosted PostgreSQL providers, matched on the hostnames they hand out. */
const MANAGED_HOSTS = [
  "supabase.co",
  "supabase.com",
  "neon.tech",
  "render.com",
  "rds.amazonaws.com",
  "azure.com",
  "cockroachlabs.cloud",
  "planetscale.com",
];

/**
 * Whether a URL points at a hosted database.
 *
 * Exported and pure so the rule can be tested without opening a connection — matching on a bare
 * substring would refuse `supabase.local`, and a guard that fires on names rather than on hosts
 * teaches people to work around it.
 */
export function isManagedHost(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase();

  return MANAGED_HOSTS.some((managed) => host === managed || host.endsWith(`.${managed}`));
}

/**
 * Refuse to run against a hosted database.
 *
 * This function's first act is `DROP DATABASE ... WITH (FORCE)`, which terminates live connections
 * and destroys the database behind them. Pointing `TR4CE_TEST_DATABASE_URL` at a deployed project —
 * a copied line in a shell, a `.env` shared between machines — would do exactly that, with no
 * confirmation and nothing to undo it.
 *
 * The check is on the hostname rather than on a flag, because a flag protects only the people who
 * remember to set it. It is also not merely about safety: a Supabase project is a single database
 * with Studio, PostgREST and Auth all bound to `postgres` (Supabase discussion #4471), so the four
 * databases these suites provision have nowhere to exist there in the first place.
 */
function refuseManagedHost(baseUrl: string): void {
  if (isManagedHost(baseUrl)) {
    throw new Error(
      `TR4CE_TEST_DATABASE_URL points at ${new URL(baseUrl).hostname}, a hosted database. ` +
        "This function drops and recreates databases; run the integration suites against a local " +
        "PostgreSQL instance instead (docker compose up -d postgres).",
    );
  }
}
