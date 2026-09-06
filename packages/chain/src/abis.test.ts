import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { erc4626Abi } from "./abis.js";

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

  it("declares every entry as a view function", () => {
    // Nothing in this package may change state. The action layer builds its own calldata under
    // explicit wallet approval; a mutable entry here would be a path around that.
    for (const entry of erc4626Abi) {
      expect(entry.stateMutability).toBe("view");
    }
  });
});
