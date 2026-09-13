import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { erc20Abi, erc4626Abi } from "./abis.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Drift between the two ERC-4626 ABIs in this repo.
 *
 * The Substreams module reads `substreams/erc4626/abi/erc4626.json` at build time; this package
 * declares its own `const` because viem derives return types from the literal. Two definitions of
 * the same interface will drift the moment anyone edits one, and a signature mismatch would mean
 * the indexer and the live reader decode the same contract differently — the kind of divergence
 * that produces two plausible numbers with no indication which is wrong.
 */

interface AbiFunction {
  type: string;
  name: string;
  inputs: { type: string }[];
  outputs: { type: string }[];
}

const substreamsAbi = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "substreams",
      "erc4626",
      "abi",
      "erc4626.json",
    ),
    "utf8",
  ),
) as AbiFunction[];

const signature = (entry: { inputs: readonly { type: string }[]; outputs: readonly { type: string }[] }) =>
  `(${entry.inputs.map((i) => i.type).join(",")})->(${entry.outputs.map((o) => o.type).join(",")})`;

describe("ABI agreement with the Substreams package", () => {
  const shared = substreamsAbi.filter((entry) => entry.type === "function");

  it("covers every function the indexer calls", () => {
    // The indexer's set is a subset of ours by design: it decodes events and makes block-scoped
    // reads, while this package also serves the action layer.
    const ours = new Set(erc4626Abi.map((entry) => entry.name));

    for (const entry of shared) {
      expect(ours.has(entry.name as never)).toBe(true);
    }
  });

  it("declares identical signatures for every shared function", () => {
    for (const entry of shared) {
      const ours = erc4626Abi.find((candidate) => candidate.name === entry.name)!;

      expect(signature(ours), `signature drift on ${entry.name}`).toBe(signature(entry));
    }
  });
});

describe("read surface", () => {
  it("covers all eight methods the PRD requires", () => {
    // PRD section 8.1 names these as the current reads recorded with raw outcomes.
    const required = [
      "asset",
      "totalAssets",
      "totalSupply",
      "convertToAssets",
      "maxWithdraw",
      "maxRedeem",
      "previewDeposit",
      "previewRedeem",
    ];

    const names = erc4626Abi.map((entry) => entry.name);

    for (const method of required) {
      expect(names).toContain(method);
    }
  });

  it("declares exactly two state-changing functions, and names them", () => {
    /*
     * This assertion used to read "every entry is a view function". Task 7 made that false for a
     * good reason — `deposit` and `redeem` calldata has to be built somewhere — but the guarantee
     * behind it has not changed, so the list is pinned rather than the check dropped.
     *
     * A third mutable entry appearing here would mean TR4CE learned to encode an operation nobody
     * reviewed. That is what this now catches.
     */
    const mutable = erc4626Abi
      .filter((entry) => entry.type === "function" && entry.stateMutability !== "view")
      .map((entry) => entry.name);

    expect(mutable.sort()).toEqual(["deposit", "redeem"]);
  });

  it("declares approve as the only state-changing ERC-20 entry", () => {
    const mutable = erc20Abi
      .filter((entry) => entry.stateMutability !== "view")
      .map((entry) => entry.name);

    expect(mutable).toEqual(["approve"]);
  });
});

describe("the package cannot submit a transaction", () => {
  /*
   * Task 7's acceptance clause: "There is no service method that signs or submits."
   *
   * Encoding calldata for `deposit` is not the same as being able to send it, and the difference
   * is worth checking rather than asserting in a comment. viem separates the two — a `PublicClient`
   * has no `sendTransaction` and no account — so the property holds as long as nothing here reaches
   * for the other half of the library.
   *
   * Read from source rather than from types: a `WalletClient` created at runtime would type-check
   * perfectly well.
   */
  const sources = readdirSync(here)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => [name, readFileSync(join(here, name), "utf8")] as const);

  const forbidden = [
    "createWalletClient",
    "walletClient",
    "sendTransaction",
    "sendRawTransaction",
    "writeContract",
    "privateKeyToAccount",
    "signTransaction",
  ];

  for (const [name, source] of sources) {
    it(`${name} reaches for no signing or submitting API`, () => {
      // Comments stripped: the prose in these files necessarily names the very things it forbids.
      const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

      for (const api of forbidden) {
        expect(code).not.toContain(api);
      }
    });
  }
});
