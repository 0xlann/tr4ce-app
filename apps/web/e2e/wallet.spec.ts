import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * The wallet half of Task 9: prepare, review the exact bytes, sign, report the hash.
 *
 * Two things make this a real test rather than a walkthrough of a mock.
 *
 * The action is prepared by the API against the live registry, so the calldata is whatever the chain
 * and the owner's allowance actually imply — one call or two, decided by the vault, not by a
 * fixture. And the bytes handed to the wallet are compared against the bytes rendered on the page.
 * "Exact wallet preview" is only a claim until something asserts that the two are the same string.
 *
 * **Nothing is broadcast.** wagmi's mock connector forwards `eth_sendTransaction` to whatever RPC
 * the transport names, so the request is intercepted here and answered with a canned hash. The
 * interception is also what makes the comparison possible: the intercepted body is the wallet's view
 * of the transaction.
 *
 * Requires a build made with `NEXT_PUBLIC_TR4CE_WALLET_MODE=mock`, because that flag is inlined at
 * build time. `TR4CE_E2E_WALLET=mock` says such a build is being served.
 */

const RPC = "**/mainnet.base.org/**";
const MOCK_ACCOUNT = "0x1111111111111111111111111111111111111111";

/**
 * A hash no other transaction has used.
 *
 * `transaction_receipt` is unique on `(chain_id, transaction_hash)`, and rightly so: one hash
 * belongs to one call of one action, and recording it twice would attribute the same transaction to
 * two different intents. A fixed stand-in hash makes the first run pass and every run after it fail
 * on that constraint, which looks like a product bug and is not one.
 */
function freshHash(): string {
  const hex = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]);

  return `0x${hex.join("")}`;
}

test.describe("signing a prepared action", () => {
  test.skip(
    process.env["TR4CE_E2E_WALLET"] !== "mock",
    "Needs a build made with NEXT_PUBLIC_TR4CE_WALLET_MODE=mock.",
  );

  // Every step here waits on the real API: preparing simulates against the chain, and resimulating
  // does it again. The default 30s covers neither on a cold connection pool.
  test.setTimeout(180_000);

  test("shows the exact bytes it hands to the wallet", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];

    await interceptRpc(page, sent);

    const reportUrl = await reachAReport(page);

    expect(reportUrl).toMatch(/\/reports\/trc_[0-9a-f]{32}/);

    await connect(page);

    await expect(page.getByRole("region", { name: "Wallet" }).first()).toContainText(MOCK_ACCOUNT);

    /*
     * A small deposit, in base units. USDC has six decimals, so this is one dollar — enough for the
     * vault to preview shares against, and small enough that the amount is obviously not the point.
     */
    await page.getByLabel("Deposit amount").fill(uniqueAmount());
    await page.getByRole("button", { name: "Prepare action" }).click();

    await page.waitForURL(/\/actions\/act_[0-9a-f]{32}/, { timeout: 60_000 });

    // Every call is rendered, in signing order. A deposit is two calls when the allowance is short.
    const calls = page.locator("[data-call-index]");
    const callCount = await calls.count();

    expect(callCount).toBeGreaterThanOrEqual(1);

    const shown = await page.getByTestId("calldata-0").innerText();

    expect(shown).toMatch(/^0x[0-9a-f]+$/i);

    /*
     * Base produces a block every two seconds, so an action is routinely past its block budget by
     * the time a person has read it. Resimulating is the documented way back to signable, and this
     * is where a user meets it.
     */
    const sign = page.getByRole("button", { name: /^Sign / });

    if (!(await sign.isEnabled())) {
      await page.getByRole("button", { name: "Resimulate" }).click();
      await expect(sign).toBeEnabled({ timeout: 60_000 });
    }

    await sign.click();

    await expect
      .poll(() => sent.length, { timeout: 60_000, message: "the wallet was never asked to sign" })
      .toBeGreaterThan(0);

    const request = sent[0]!;

    /*
     * The assertion this file exists for.
     *
     * The `data` the wallet was handed is character-for-character the `data` the page displayed. A
     * page that rendered one payload and signed another would satisfy every other check here.
     */
    expect(String(request["data"]).toLowerCase()).toBe(shown.toLowerCase());
    expect(String(request["from"]).toLowerCase()).toBe(MOCK_ACCOUNT.toLowerCase());

    /*
     * The hash was reported and the action moved on. Asserted on the call ledger rather than on the
     * hash itself: an ERC-20 approval emits no ERC-4626 event, so it has no outcome to show — and
     * inventing one from the preview is precisely what this product refuses to do.
     */
    await expect(page.getByText(/Signed and reported \(1 of 2\)/)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-call-index="0"]')).toContainText("reported");
    await expect(page.locator('[data-call-index="1"]')).toContainText("next");

    /*
     * And the second call is refused, for the right reason.
     *
     * PRD TR-F-032: the approval's simulation says nothing about whether the deposit will succeed,
     * so the deposit is left unsimulated until its predecessor lands rather than being claimed as
     * simulated. This is that rule reaching a screen.
     */
    await expect(page.getByText(/has not been simulated yet/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Sign / })).toBeDisabled();
  });

  test("approves the exact amount rather than an unlimited allowance", async ({ page }) => {
    /*
     * PRD TR-F-034, read off the bytes the wallet is actually handed.
     *
     * An `approve` for 2^256-1 is the ordinary shortcut and the ordinary way a user ends up with a
     * standing allowance they did not think they granted. The calldata here has to end in the
     * amount that was asked for, and must not be the max-uint pattern.
     */
    const sent: Record<string, unknown>[] = [];

    await interceptRpc(page, sent);
    await reachAReport(page);
    await connect(page);

    const amount = uniqueAmount();

    await page.getByLabel("Deposit amount").fill(amount);
    await page.getByRole("button", { name: "Prepare action" }).click();
    await page.waitForURL(/\/actions\/act_[0-9a-f]{32}/, { timeout: 60_000 });

    const first = page.locator('[data-call-index="0"]');

    if (!(await first.innerText()).toLowerCase().includes("approve")) {
      // The allowance already covered the amount, so there is no approval to inspect.
      test.skip(true, "This owner already has an allowance; the deposit is a single call.");
    }

    const calldata = (await page.getByTestId("calldata-0").innerText()).toLowerCase();

    // approve(spender, value): selector, then the spender, then the value, each 32 bytes.
    const encoded = BigInt(amount).toString(16).padStart(64, "0");

    expect(calldata.startsWith("0x095ea7b3")).toBe(true);
    expect(calldata.endsWith(encoded)).toBe(true);

    // And emphatically not the max-uint shortcut, which is how a standing allowance gets granted
    // by accident.
    expect(calldata).not.toContain("f".repeat(64));
  });

  test("refuses to sign for an account the action was not prepared for", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];

    await interceptRpc(page, sent);
    await reachAReport(page);
    await connect(page);

    await page.getByLabel("Deposit amount").fill(uniqueAmount());
    await page.getByRole("button", { name: "Prepare action" }).click();
    await page.waitForURL(/\/actions\/act_[0-9a-f]{32}/, { timeout: 60_000 });

    /*
     * Disconnecting is the reachable way to make the connected account stop matching the owner.
     * `actionDigest` covers the account, so a signature from another one could never settle against
     * this action — the point is that the interface says so before the user pays gas, rather than
     * the server saying so afterwards.
     */
    await page.getByRole("button", { name: "Disconnect" }).first().click();

    const sign = page.getByRole("button", { name: /^Sign / });

    await expect(sign).toBeDisabled();
    await expect(page.getByText(/Connect the wallet that owns this action/i).first()).toBeVisible();

    expect(sent).toHaveLength(0);
  });

  test("explains a cold load instead of showing empty calldata", async ({ page }) => {
    await interceptRpc(page, []);
    await reachAReport(page);
    await connect(page);

    await page.getByLabel("Deposit amount").fill(uniqueAmount());
    await page.getByRole("button", { name: "Prepare action" }).click();
    await page.waitForURL(/\/actions\/act_[0-9a-f]{32}/, { timeout: 60_000 });

    const actionUrl = page.url();

    /*
     * A different tab, which is what a shared link is. `GET /v1/actions/:id` carries no calldata, so
     * this page can show where the action stands but not the bytes — and it has to say which.
     */
    const cold = await page.context().newPage();

    await cold.goto(actionUrl);

    await expect(cold.getByText(/Not available in this tab/i)).toBeVisible({ timeout: 60_000 });
    await expect(cold.locator("[data-call-index]")).toHaveCount(0);

    // The status still came through, so the page is informative rather than broken.
    await expect(cold.getByRole("list", { name: "Action progress" })).toBeVisible();

    await cold.close();
  });
});

/**
 * Answer the chain's public endpoint locally.
 *
 * Every JSON-RPC call the mock connector makes is served here, so no request leaves the machine and
 * no transaction is broadcast. `eth_sendTransaction` bodies are captured into `sent` — that capture
 * is the wallet's own view of what it was asked to sign.
 */
async function interceptRpc(page: Page, sent: Record<string, unknown>[]): Promise<void> {
  await page.route(RPC, async (route) => {
    const body = payloadOf(route.request());
    const method = typeof body?.["method"] === "string" ? body["method"] : "";

    if (method === "eth_sendTransaction") {
      const params = body?.["params"];

      if (Array.isArray(params) && params[0] !== undefined) {
        sent.push(params[0] as Record<string, unknown>);
      }

      await fulfil(route, body, freshHash());

      return;
    }

    if (method === "eth_chainId") {
      await fulfil(route, body, "0x2105");

      return;
    }

    if (method === "eth_accounts" || method === "eth_requestAccounts") {
      await fulfil(route, body, [MOCK_ACCOUNT]);

      return;
    }

    // Anything else is answered rather than passed through, so an unexpected call is visibly inert
    // instead of quietly reaching a public node.
    await fulfil(route, body, null);
  });
}

async function fulfil(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: Record<string, unknown> | null,
  result: unknown,
): Promise<void> {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: body?.["id"] ?? 1, result }),
  });
}

function payloadOf(request: Request): Record<string, unknown> | null {
  try {
    return request.postDataJSON() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A deposit amount no earlier run has used.
 *
 * Preparing is idempotent on the calldata hash while an action is still `prepared` or `simulated`,
 * so asking twice for the same amount returns the action that already exists — including one a
 * previous run left half-signed, whose approval will never land because nothing here broadcasts.
 * Varying the amount asks a genuinely new question each time.
 *
 * Still about one USDC: six decimals, so this ranges over roughly 1.00 to 1.01.
 */
function uniqueAmount(): string {
  return String(1_000_000 + (Date.now() % 10_000));
}

/** Connect the mock wallet the way a person would, rather than assuming a connected session. */
async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(page.getByRole("button", { name: "Disconnect" }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** The read-only path, reused: a policy, a mixed result, and a report that was actually written. */
async function reachAReport(page: Page): Promise<string> {
  await page.goto("/search");
  await page.getByRole("button", { name: "lenient" }).click();
  await page.getByRole("button", { name: /Evaluate policy/i }).click();
  await expect(page.getByRole("table")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: /Inspect/i }).first().click();
  await page.waitForURL(/\/reports\/trc_[0-9a-f]{32}/, { timeout: 60_000 });

  const prepare = page.getByRole("button", { name: "Prepare action" });

  await prepare.scrollIntoViewIfNeeded();

  return page.url();
}
