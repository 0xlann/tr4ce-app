import { describe, expect, it } from "vitest";

import type { EvaluationOutcome } from "../../src/api/evaluation.js";
import { compareOutcomes, completeness } from "./compare-outcomes.js";
import type { VaultRow } from "./vault-row.js";

/**
 * The ordering rule the acceptance clause names: "no APY headline outranks policy status."
 *
 * Checked as behaviour rather than trusted to the comparator reading correctly, because the failure
 * this guards against is silent — a table sorted by return still renders, and still looks right.
 */

const vault = (address: string, name: string): VaultRow => ({
  chainId: 8453 as VaultRow["chainId"],
  address: address as VaultRow["address"],
  symbol: name,
  name,
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as VaultRow["asset"],
  assetSymbol: "USDC",
  shareDecimals: 6,
  status: "listed",
  adapterKey: "erc4626-standard",
  adapterVersion: "1.0.0",
});

const outcome = (
  address: string,
  status: EvaluationOutcome["status"],
  unknownRules = 0,
  returnBps = "0",
): EvaluationOutcome => ({
  vaultAddress: address as EvaluationOutcome["vaultAddress"],
  status,
  asOfBlock: "50879900",
  rules:
    status === null
      ? null
      : [
          "underlyingAsset",
          "minimumHistory",
          "minimumTvl",
          "minimumObservedReturn",
          "minimumWithdrawableAssets",
        ].map((key, index) => ({
          key,
          status: index < unknownRules ? ("UNKNOWN" as const) : ("PASS" as const),
          threshold: "0",
          observedValue: key === "minimumObservedReturn" ? returnBps : "1",
          reasonCodes: [],
        })),
  issues: [],
  unavailable: status === null ? "The evidence API refused." : null,
});

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";

const vaults: VaultRow[] = [vault(A, "Alpha"), vault(B, "Bravo"), vault(C, "Charlie")];

describe("compareOutcomes", () => {
  it("never ranks UNKNOWN above PASS", () => {
    const order = compareOutcomes(vaults, [
      outcome(A, "UNKNOWN", 2),
      outcome(B, "PASS"),
      outcome(C, "FAIL"),
    ]).map((row) => row.outcome.status);

    expect(order).toEqual(["PASS", "FAIL", "UNKNOWN"]);
  });

  it("never lets a higher return outrank a worse verdict", () => {
    /*
     * The acceptance clause, as an assertion. The failing vault returns 40x more than the passing
     * one; if return entered the comparator at all, it would come first.
     */
    const order = compareOutcomes(vaults, [
      outcome(A, "FAIL", 0, "4000"),
      outcome(B, "PASS", 0, "100"),
    ]).map((row) => row.outcome.status);

    expect(order[0]).toBe("PASS");
  });

  it("puts the better-evidenced vault first within one status", () => {
    // A PASS drawn from five observed rules is a stronger answer than one drawn from three.
    const order = compareOutcomes(vaults, [
      outcome(A, "PASS", 2),
      outcome(B, "PASS", 0),
    ]).map((row) => row.vault.address);

    expect(order[0]).toBe(B);
  });

  it("sorts a vault with no verdict last rather than treating it as a failure", () => {
    // "We could not answer" is the least useful row, not the worst outcome. Ranking it with FAIL
    // would report an absence of evidence as evidence.
    const order = compareOutcomes(vaults, [
      outcome(A, null),
      outcome(B, "FAIL"),
      outcome(C, "UNKNOWN", 1),
    ]).map((row) => row.outcome.status);

    expect(order[order.length - 1]).toBeNull();
  });

  it("drops an outcome for a vault the registry does not list", () => {
    // The evaluator answers about what it was asked; rendering a row for a vault the registry never
    // returned would put an unverified address in a table of verified ones.
    const rows = compareOutcomes(vaults, [outcome("0x00000000000000000000000000000000000000ff", "PASS")]);

    expect(rows).toHaveLength(0);
  });
});

describe("completeness", () => {
  it("counts only the rules that reached an observation", () => {
    expect(completeness(outcome(A, "UNKNOWN", 2))).toBe(3);
    expect(completeness(outcome(A, "PASS", 0))).toBe(5);
  });

  it("is zero when no rule was evaluated at all", () => {
    expect(completeness(outcome(A, null))).toBe(0);
  });
});
