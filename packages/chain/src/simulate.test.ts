import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import {
  actionDigest,
  bindingDigest,
  checkSignable,
  EXPIRY_BLOCKS,
  EXPIRY_SECONDS,
  type SimulationBinding,
  type SimulationResult,
} from "./simulate.js";
import type { PreparedCall } from "./prepare.js";

/**
 * Task 7's acceptance clause: "changing any bound field makes the action non-signable until
 * resimulation."
 *
 * Checked field by field rather than in aggregate. A test that mutated one field and stopped would
 * pass while six others went unbound, and the clause is a claim about all seven.
 */

const BLOCK = 50_879_900n;
const TIMESTAMP = Math.floor(Date.parse("2026-09-05T00:00:00.000Z") / 1000);

const binding = (overrides: Partial<SimulationBinding> = {}): SimulationBinding => ({
  chainId: 8453,
  account: "0x1111111111111111111111111111111111111111",
  to: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
  dataHash: keccak256("0xdeadbeef"),
  value: "0",
  blockNumber: BLOCK.toString(),
  blockHash: `0x${"a".repeat(64)}`,
  capabilityVersion: "metamorpho-1.1",
  ...overrides,
});

const succeeded = (overrides: Partial<SimulationResult> = {}): SimulationResult => ({
  status: "SUCCEEDED",
  binding: binding(),
  gasEstimate: 182_000n,
  revertData: null,
  message: null,
  expiresAtBlock: BLOCK + EXPIRY_BLOCKS,
  expiresAt: new Date((TIMESTAMP + EXPIRY_SECONDS) * 1000).toISOString(),
  ...overrides,
});

const at = (offsetSeconds: number) => new Date((TIMESTAMP + offsetSeconds) * 1000);

describe("every bound field", () => {
  /*
   * The seven fields SMART-CONTRACT.md section 6 names. Listed as data so the count is visible: if
   * the binding grows an eighth field and nobody adds it here, the length assertion below fails.
   */
  const mutations: [string, Partial<SimulationBinding>][] = [
    ["chainId", { chainId: 1 }],
    ["account", { account: "0x2222222222222222222222222222222222222222" }],
    ["to", { to: "0xef417a2512C5a41f69AE4e021648b69a7CdE5D03" }],
    ["dataHash", { dataHash: keccak256("0xfeedface") }],
    ["value", { value: "1" }],
    ["blockNumber", { blockNumber: (BLOCK + 1n).toString() }],
    ["blockHash", { blockHash: `0x${"b".repeat(64)}` }],
    ["capabilityVersion", { capabilityVersion: "metamorpho-1.2" }],
  ];

  it("is covered by a mutation case", () => {
    // The binding carries eight properties; section 6 counts blockNumber and blockHash as one
    // "block" field, which is why the prose says seven and this says eight.
    expect(mutations.map(([name]) => name).sort()).toEqual(Object.keys(binding()).sort());
  });

  for (const [field, change] of mutations) {
    it(`makes the action non-signable when ${field} changes`, () => {
      const verdict = checkSignable({
        simulation: succeeded(),
        current: binding(change),
        currentBlock: BLOCK,
        now: at(0),
      });

      expect(verdict).toEqual({ signable: false, reason: "BINDING_CHANGED" });
    });
  }

  it("stays signable when nothing changed", () => {
    // The control. Without it every assertion above would also pass on a function that always
    // refused.
    expect(
      checkSignable({
        simulation: succeeded(),
        current: binding(),
        currentBlock: BLOCK,
        now: at(0),
      }),
    ).toEqual({ signable: true });
  });

  it("does not care how an address is spelled", () => {
    /*
     * A checksummed and a lowercase spelling are the same contract. Treating them as different
     * would expire actions for no reason and teach people to ignore the warning — and the two
     * spellings genuinely arrive from different places: viem returns checksummed addresses, the
     * database stores bytes that come back lowercase.
     */
    expect(
      checkSignable({
        simulation: succeeded(),
        current: binding({ to: "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61" }),
        currentBlock: BLOCK,
        now: at(0),
      }),
    ).toEqual({ signable: true });
  });
});

describe("expiry", () => {
  it("survives to the third block and not past it", () => {
    /*
     * The block bound, checked at its edge. On Base at two-second blocks this is the bound that
     * almost always fires first, so a test that only moved the clock would leave it unproven.
     */
    const stillGood = checkSignable({
      simulation: succeeded(),
      current: binding(),
      currentBlock: BLOCK + EXPIRY_BLOCKS,
      now: at(0),
    });

    const spent = checkSignable({
      simulation: succeeded(),
      current: binding(),
      currentBlock: BLOCK + EXPIRY_BLOCKS + 1n,
      now: at(0),
    });

    expect(stillGood).toEqual({ signable: true });
    expect(spent).toEqual({ signable: false, reason: "BLOCK_BUDGET_SPENT" });
  });

  it("expires on time even if the chain stalled", () => {
    // The other half of `min(3 blocks, 60 seconds)`. A halted chain must not leave an action
    // signable forever, which is exactly what a block-only budget would do.
    expect(
      checkSignable({
        simulation: succeeded(),
        current: binding(),
        currentBlock: BLOCK,
        now: at(EXPIRY_SECONDS + 1),
      }),
    ).toEqual({ signable: false, reason: "TIME_BUDGET_SPENT" });
  });

  it("holds to the last second", () => {
    expect(
      checkSignable({
        simulation: succeeded(),
        current: binding(),
        currentBlock: BLOCK,
        now: at(EXPIRY_SECONDS),
      }),
    ).toEqual({ signable: true });
  });
});

describe("a failed simulation", () => {
  it("is never signable, and says so rather than reporting an expiry", () => {
    /*
     * Order matters. Reporting a stale failure as "expired" would suggest resimulating fixes it,
     * and the user would repeat a transaction the chain has already refused.
     */
    const failed = succeeded({ status: "FAILED", gasEstimate: null });

    expect(
      checkSignable({
        simulation: failed,
        current: binding(),
        currentBlock: BLOCK + 99n,
        now: at(9_999),
      }),
    ).toEqual({ signable: false, reason: "SIMULATION_FAILED" });
  });
});

describe("bindingDigest", () => {
  it("is stable across two equal bindings built separately", () => {
    // Object key order is an accident of construction; the digest must not depend on it.
    const left: SimulationBinding = { ...binding() };
    const right: SimulationBinding = {
      capabilityVersion: "metamorpho-1.1",
      blockHash: `0x${"a".repeat(64)}`,
      blockNumber: BLOCK.toString(),
      value: "0",
      dataHash: keccak256("0xdeadbeef"),
      to: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
      account: "0x1111111111111111111111111111111111111111",
      chainId: 8453,
    };

    expect(bindingDigest(right)).toBe(bindingDigest(left));
  });
});

/**
 * The action digest: what a *plan* is, as opposed to what one *simulation* of it is.
 *
 * The distinction is not cosmetic. Folding the block into an action's identity is what made a
 * two-call deposit impossible to complete through the API — the approval and the deposit that
 * follows it could never belong to the same action, because the block moved in between.
 */
describe("actionDigest", () => {
  const call = (overrides: Partial<PreparedCall> = {}): PreparedCall => ({
    chainId: 8453,
    to: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
    data: "0xdeadbeef",
    value: "0",
    kind: "deposit",
    ...overrides,
  });

  const digest = (overrides: Partial<Parameters<typeof actionDigest>[0]> = {}) =>
    actionDigest({
      chainId: 8453,
      account: "0x1111111111111111111111111111111111111111",
      calls: [call()],
      capabilityVersion: "metamorpho-1.1",
      ...overrides,
    });

  it("does not move when the block does", () => {
    // There is no block in the input at all, which is the point: an action outlives every
    // simulation it accumulates, and on Base a block-bound identity would change every 2 seconds.
    expect(digest()).toBe(digest());
  });

  it("covers every call, not just the first", () => {
    /*
     * A one-call deposit and the two-call form of the same deposit are different plans. If only the
     * first call were covered, an approval-then-deposit would collide with an approval followed by
     * something else entirely.
     */
    const one = digest({ calls: [call({ kind: "approve" })] });
    const two = digest({ calls: [call({ kind: "approve" }), call()] });

    expect(one).not.toBe(two);
  });

  it("depends on the order the calls must be signed in", () => {
    const approve = call({ kind: "approve", data: "0x095ea7b3" });
    const deposit = call();

    expect(digest({ calls: [approve, deposit] })).not.toBe(digest({ calls: [deposit, approve] }));
  });

  it("changes when any covered field changes", () => {
    // Field by field, for the same reason `checkSignable` is checked that way above: an aggregate
    // assertion would pass while three of the four went uncovered.
    const base = digest();

    expect(digest({ chainId: 1 })).not.toBe(base);
    expect(digest({ account: "0x2222222222222222222222222222222222222222" })).not.toBe(base);
    expect(digest({ capabilityVersion: "metamorpho-1.2" })).not.toBe(base);
    expect(digest({ calls: [call({ value: "1" })] })).not.toBe(base);
    expect(digest({ calls: [call({ data: "0xfeedface" })] })).not.toBe(base);
    expect(digest({ calls: [call({ to: "0x3333333333333333333333333333333333333333" })] })).not.toBe(base);
    // The kind is covered too: an approval and a deposit to the same address with the same
    // calldata would otherwise be the same plan.
    expect(digest({ calls: [call({ kind: "approve" })] })).not.toBe(base);
  });

  it("ignores address casing, which a checksummed address changes and a chain does not", () => {
    expect(digest({ account: "0X1111111111111111111111111111111111111111" })).toBe(digest());
  });
});
