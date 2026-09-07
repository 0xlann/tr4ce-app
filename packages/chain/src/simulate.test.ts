import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import {
  bindingDigest,
  checkSignable,
  EXPIRY_BLOCKS,
  EXPIRY_SECONDS,
  type SimulationBinding,
  type SimulationResult,
} from "./simulate.js";

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
