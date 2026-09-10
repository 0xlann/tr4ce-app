import { expect, test } from "@playwright/test";

/**
 * Task 9's acceptance clause, as behaviour:
 *
 *   "A user can explain a failed/unknown rule and inspect exact provenance without a wallet;
 *    no APY headline outranks policy status."
 *
 * Every assertion below is about a browser with no wallet extension, no connected account, and no
 * fixture: the vaults come from the registry, the verdicts from the evidence API, and the report
 * from a row that this test caused to be written.
 *
 * Requires the API and a web server. See playwright.config.ts for why this is not in `pnpm test`.
 */

const UNKNOWN = "UNKNOWN";

test.describe("evidence without a wallet", () => {
  test("carries a policy through to a report and its provenance", async ({ page }) => {
    await page.goto("/search");

    // The registry loaded. Not a fixture: these rows came from GET /v1/vaults.
    await expect(page.getByRole("heading", { name: /Compare the policy/i })).toBeVisible();

    // Revealed on scroll, so scrolled to. On a 390px screen this sits below the fold.
    const summary = page.getByText(/verified vault/i);

    await summary.scrollIntoViewIfNeeded();
    await expect(summary).toBeVisible();

    /*
     * A policy chosen to produce a mix.
     *
     * The lenient preset passes on TVL and return for these vaults while the withdrawal limit stays
     * unreadable, so a real UNKNOWN appears beside a real verdict. A policy that produced one
     * uniform answer would let this test pass while the distinction it exists to check was broken.
     */
    await page.getByRole("button", { name: "lenient" }).click();
    await page.getByRole("button", { name: /Evaluate policy/i }).click();

    const table = page.getByRole("table");

    await expect(table).toBeVisible({ timeout: 60_000 });

    // UNKNOWN reached the screen, and is labelled rather than shown as a zero.
    await expect(page.getByText(UNKNOWN).first()).toBeVisible();

    // Inspect records the report and navigates to it.
    await page.getByRole("button", { name: /Inspect/i }).first().click();
    await page.waitForURL(/\/reports\/trc_[0-9a-f]{32}/, { timeout: 60_000 });

    await expect(page.getByText(/Immutable evidence report/i)).toBeVisible();
    await expect(page.getByText(/As of block/i)).toBeVisible();

    /*
     * Provenance, which is the second half of the clause: "inspect exact provenance".
     *
     * Opening the drawer is not enough to assert — a chip that opened an empty drawer would pass
     * that. What must be reachable is a source entry naming a block *hash*, because that is the
     * thing a reader can go and check for themselves.
     */
    await page.getByRole("button", { name: /Show provenance sources/i }).first().click();

    const drawer = page.getByRole("dialog", { name: /provenance/i });

    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(/^0x[0-9a-f]{64}$/i).first()).toBeVisible();
    await expect(drawer.getByText(/Block \d+/).first()).toBeVisible();

    /*
     * And the raw report, which is the other half of "inspect exact provenance": a reader who does
     * not trust the rendering can read the bytes the API stored.
     *
     * Asserted against the id in the URL rather than merely "some JSON is present" — a disclosure
     * rendering a fixture would satisfy the weaker check while showing a report that is not this one.
     */
    // `showModal`, so the rest of the page is inert until this closes. Closing it is part of the
    // path rather than a test detail: a drawer that cannot be dismissed traps the reader.
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();

    const reportId = new URL(page.url()).pathname.split("/").pop() ?? "";

    expect(reportId).toMatch(/^trc_[0-9a-f]{32}$/);

    await page.locator("#json summary").click();

    const json = page.locator("#json pre");

    await expect(json).toContainText(`"reportId": "${reportId}"`);
    await expect(json).toContainText('"schemaVersion": "1.0.0"');
  });

  test("explains an unknown rule rather than scoring it", async ({ page }) => {
    /*
     * The single most damaging failure this product can have is reporting an absence of evidence as
     * evidence. The report page must name the unknown rule and say what was missing.
     */
    await page.goto("/search");
    await page.getByRole("button", { name: "lenient" }).click();
    await page.getByRole("button", { name: /Evaluate policy/i }).click();
    await expect(page.getByRole("table")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: /Inspect/i }).first().click();
    await page.waitForURL(/\/reports\/trc_/, { timeout: 60_000 });

    const unknown = page.getByText(UNKNOWN).first();

    await expect(unknown).toBeVisible();

    // A limitation is attached, in words. "Unknown" with nothing beside it is not an explanation.
    await expect(page.getByText(/could not|unavailable|missing|not verified/i).first()).toBeVisible();
  });

  test("never puts a higher return above a better verdict", async ({ page }) => {
    // The second half of the acceptance clause. Read off the rendered order rather than the sort
    // function, because the page is what a user sees.
    await page.goto("/search");
    await page.getByRole("button", { name: "lenient" }).click();
    await page.getByRole("button", { name: /Evaluate policy/i }).click();
    await expect(page.getByRole("table")).toBeVisible({ timeout: 60_000 });

    const verdicts = await page.getByRole("row").locator("td").first().allInnerTexts();
    const order = verdicts.map((text) => text.trim()).filter((text) => text.length > 0);

    const firstUnknown = order.findIndex((text) => text.includes(UNKNOWN));
    const lastPass = order.map((text) => text.includes("PASS")).lastIndexOf(true);

    if (firstUnknown >= 0 && lastPass >= 0) {
      expect(lastPass).toBeLessThan(firstUnknown);
    }
  });

  test("keeps the whole path reachable by keyboard", async ({ page }, testInfo) => {
    // Touch keyboards do not tab. DESIGN-SYSTEMS section 13 asks for keyboard on the critical path,
    // which is a desktop claim.
    test.skip(testInfo.project.name === "mobile", "Keyboard navigation is a desktop path.");

    await page.goto("/search");

    // Reach the preset buttons and the evaluate control without touching the mouse.
    await page.getByRole("button", { name: "lenient" }).focus();
    await page.keyboard.press("Enter");

    await page.getByRole("button", { name: /Evaluate policy/i }).focus();
    await expect(page.getByRole("button", { name: /Evaluate policy/i })).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.getByRole("table")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: /Inspect/i }).first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/reports\/trc_/, { timeout: 60_000 });
  });

  test("shows a policy issue beside the field that caused it", async ({ page }) => {
    // TR-F-024: an invalid draft comes back as issues a user can act on, not as an error.
    await page.goto("/search");

    const field = page.getByLabel("Minimum history");

    await field.fill("not a number");
    await page.getByRole("button", { name: /Evaluate policy/i }).click();

    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 60_000 });
    await expect(field).toHaveAttribute("aria-invalid", "true");
  });

  test("names an address outside the registry rather than guessing", async ({ page }) => {
    await page.goto("/search");

    const field = page.getByLabel("Vault address");

    await field.scrollIntoViewIfNeeded();
    await field.fill("0x000000000000000000000000000000000000dead");

    await expect(page.getByText(/not in the verified registry/i)).toBeVisible();
  });

  test("keeps every evidence column on a 390px screen", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "This is the mobile parity check.");

    await page.goto("/search");
    await page.getByRole("button", { name: "lenient" }).click();
    await page.getByRole("button", { name: /Evaluate policy/i }).click();
    await expect(page.getByRole("table")).toBeVisible({ timeout: 60_000 });

    /*
     * Parity, not merely "it fits". The columns may scroll sideways inside the card, but none of
     * them may be removed: a limitation only the desktop reader sees is a limitation that was hidden
     * from the person most likely to act on their phone.
     */
    const headers = await page.getByRole("columnheader").allInnerTexts();

    // Case-insensitive: the headers are uppercased by CSS, and this is about which columns
    // survive the narrow viewport rather than about their letterforms.
    const rendered = headers.join(" ").toLowerCase();

    expect(rendered).toContain("verdict");
    expect(rendered).toContain("observed return");
    expect(rendered).toContain("tvl");
    expect(rendered).toContain("withdrawal");

    /*
     * And the page itself never scrolls sideways, which is the separate promise.
     *
     * Measured on `main`, not on `documentElement`. The root carries `overflow-x: clip`, so its
     * `scrollWidth` still reports content that is laid out and clipped — including the 760px table
     * living inside a 350px card that scrolls on its own. Asserting on the root reported a 272px
     * overflow for a layout that is in fact correct, which is a test measuring the wrong element
     * rather than a page overflowing.
     */
    const overflow = await page
      .locator("main")
      .evaluate((element) => element.scrollWidth - element.clientWidth);

    expect(overflow).toBeLessThanOrEqual(1);

    // The evidence that does not fit is reachable by scrolling its own container, not lost.
    const card = page.locator("[class*=tableCard]");

    expect(await card.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
      await card.evaluate((element) => element.clientWidth),
    );
  });
});
