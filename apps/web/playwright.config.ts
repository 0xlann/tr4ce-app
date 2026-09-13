import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end, against a running stack.
 *
 * Deliberately **not** part of `pnpm test`. This suite needs a database, the evidence API and a web
 * server; turbo runs `test` in every package, and a 114 MB browser download is not something
 * `pnpm test` should require of someone checking out the repo. Run it explicitly:
 *
 *   pnpm --filter @tr4ce/web e2e
 *
 * `TR4CE_E2E_BASE_URL` points at an already-running app. Without it the config starts one, which is
 * the shape CI wants; the API must be up either way, because the point of these tests is that the
 * interface tells the truth about real evidence rather than about a fixture.
 */

const baseURL = process.env["TR4CE_E2E_BASE_URL"] ?? "http://localhost:3100";
const external = process.env["TR4CE_E2E_BASE_URL"] !== undefined;

export default defineConfig({
  testDir: "./e2e",
  // One worker: the flow writes reports, and two browsers racing to mint the same one would make a
  // failure look like a product bug rather than a test one.
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    /*
     * 390px: DESIGN-SYSTEMS section 14 requires mobile to retain all evidence, not a subset.
     *
     * Chromium at a phone viewport rather than the iPhone device descriptor, which defaults to
     * WebKit and would make this suite depend on a second browser engine. What is being checked here
     * is layout and column parity, and that is a viewport question rather than an engine one.
     */
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: false,
        hasTouch: true,
      },
    },
  ],
  ...(external
    ? {}
    : {
        webServer: {
          command: "next start -p 3100",
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
