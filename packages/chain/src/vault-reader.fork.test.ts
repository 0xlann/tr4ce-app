import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import type { Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import { classifyCapabilities, ownerHoldsShares } from "./capabilities.js";
import {
  blockTimestamp,
  createChainClient,
  readVaultAt,
  type VaultReadResults,
} from "./vault-reader.js";

/**
 * Reads against Base at pinned blocks.
 *
 * Gated on RPC_URL_BASE, the same way the database suites are gated on TR4CE_TEST_DATABASE_URL, so
 * `pnpm test` stays green with no network.
 *
 * The blocks are the two the onboarding gate already probed for every curated vault — the declared
 * window start and the verification head — so these assertions check against behaviour that was
 * recorded independently with `cast`, rather than against expectations invented alongside the code.
 * The manifest is the fixture.
 *
 * Every read happens once, in `beforeAll`, and the assertions examine the captured results. That is
 * not only faster: issuing a fresh read per assertion put enough load on the public endpoint to get
 * throttled, and a throttled read arrives here as a failed call — indistinguishable from a revert
 * without looking closely. Reading once keeps the suite testing the reader rather than the provider.
 *
 * Deviation from TECH-STACK.md section 9, which names "Anvil/fork + viem": these are direct
 * `eth_call`s at pinned blocks against an archival provider. The binding constraint in that section
 * is the sentence after it — "Do not mock the EVM behavior that the product claims to verify" — and
 * pinned real calls satisfy it with identical values and no process to manage. Anvil belongs to
 * Task 7, which needs a writable fork to simulate state-changing actions.
 */

const rpcUrl = process.env["RPC_URL_BASE"];

const WINDOW_START = 50_577_041n;
const VERIFIED_HEAD = 50_879_441n;

const listed = baseUsdcVaultManifest.vaults;
const USDC = baseUsdcVaultManifest.canonicalAssets[0]!.address.toLowerCase();

interface VaultCapture {
  atWindowStart: VaultReadResults;
  atVerifiedHead: VaultReadResults;
}

describe.skipIf(rpcUrl === undefined).sequential("ERC-4626 reads at pinned Base blocks", () => {
  const captured = new Map<string, VaultCapture>();
  let deploymentTimestamp: string | null = null;
  let headTimestamp: string | null = null;

  beforeAll(async () => {
    const client = createChainClient(rpcUrl!);

    /*
     * One pass, one multicall per (vault, block).
     *
     * RPC_URL_BASE must be a keyed endpoint. A public one throttles a burst like this, and a
     * throttled call arrives here as a failed read — indistinguishable from a revert unless you
     * read the message. That is not a hypothetical: it is what put false `reverted` statuses into
     * the vault manifest, which `scripts/reprobe-manifest.mjs` had to go back and correct.
     */
    for (const vault of listed) {
      const oneShareUnits = 10n ** BigInt(vault.shareDecimals);
      const address = vault.address as Address;

      const atWindowStart = await readVaultAt(client, {
        vault: address,
        blockNumber: WINDOW_START,
        oneShareUnits,
      });

      const atVerifiedHead = await readVaultAt(client, {
        vault: address,
        blockNumber: VERIFIED_HEAD,
        oneShareUnits,
        // The vault holds no shares in itself, so capacity reads answer honestly with zero — which
        // is exactly the case that must classify as `supported`, not as the non-standard zero.
        owner: address,
      });

      captured.set(vault.address, { atWindowStart, atVerifiedHead });
    }

    headTimestamp = await blockTimestamp(client, VERIFIED_HEAD);
    deploymentTimestamp = await blockTimestamp(client, BigInt(listed[0]!.deploymentBlock));
  }, 120_000);

  describe.each(listed.map((vault) => [vault.symbol, vault] as const))("%s", (_symbol, vault) => {
    const capture = () => captured.get(vault.address)!;

    it("reports the canonical USDC address as its asset", () => {
      // Identity rests on the address the contract returns, never on a ticker it reports about
      // itself (SMART-CONTRACT.md section 2).
      const { asset } = capture().atVerifiedHead;

      expect(asset.ok).toBe(true);
      expect(asset.ok && asset.value.toLowerCase()).toBe(USDC);
    });

    it("returns a positive share value and total assets at the verification head", () => {
      const { totalAssets, convertToAssets } = capture().atVerifiedHead;

      expect(totalAssets.ok && totalAssets.value > 0n).toBe(true);
      expect(convertToAssets.ok && convertToAssets.value > 0n).toBe(true);
    });

    it("matches the raw convertToAssets the onboarding gate recorded", () => {
      /*
       * The strongest assertion available: this reader and the `cast` calls in verify-vault.sh must
       * produce the same bytes at the same block. Two independent paths to one value.
       */
      const recorded = listed
        .find((entry) => entry.address === vault.address)!
        .evidence.latestProbes.find((probe) => probe.method === "convertToAssets")!;

      expect(recorded.atBlock).toBe(VERIFIED_HEAD.toString());

      const { convertToAssets } = capture().atVerifiedHead;

      expect(convertToAssets.ok && convertToAssets.value).toBe(BigInt(recorded.rawResult!));
    });

    it("reads history at the declared window start", () => {
      // Proves the provider is archival across the whole declared window, which every historical
      // claim in the product rests on.
      expect(capture().atWindowStart.convertToAssets.ok).toBe(true);
    });

    it("does not report share value falling over the window", () => {
      const start = capture().atWindowStart.convertToAssets;
      const end = capture().atVerifiedHead.convertToAssets;

      expect(start.ok && end.ok && end.value >= start.value).toBe(true);
    });

    it("classifies its reads without inventing anything", () => {
      const results = capture().atVerifiedHead;
      const probes = classifyCapabilities({
        results,
        atBlock: VERIFIED_HEAD.toString(),
        ownerHoldsShares: ownerHoldsShares(results),
      });

      // Seven vault-wide methods plus the two account-scoped ones.
      expect(probes).toHaveLength(9);

      for (const probe of probes) {
        // Every probe either carries what came back or records why nothing did. Never neither.
        expect(probe.rawResult !== null || probe.status === "reverted").toBe(true);
      }
    });

    it("flags a zero capacity as non-standard only when the owner holds shares", () => {
      /*
       * The invariant, checked against whatever these vaults actually do rather than against an
       * assumption about them. Live Base gives all three shapes across the curated set: vaults
       * holding none of their own shares and answering zero (an honest zero), and one holding a
       * real balance with positive capacity.
       *
       * A zero is only suspicious when the owner demonstrably has something to withdraw. Flagging
       * it any other time would manufacture ambiguity out of a correct answer.
       */
      const results = capture().atVerifiedHead;
      const holds = ownerHoldsShares(results);

      const probes = classifyCapabilities({
        results,
        atBlock: VERIFIED_HEAD.toString(),
        ownerHoldsShares: holds,
      });

      const maxWithdraw = probes.find((probe) => probe.method === "maxWithdraw")!;
      const answeredZero = results.maxWithdraw?.ok === true && results.maxWithdraw.value === 0n;

      expect(maxWithdraw.status === "nonstandard_zero").toBe(answeredZero && holds);
    });
  });

  describe("block timestamps", () => {
    it("resolves a block number to the time the policy evaluator needs", () => {
      // Without this the evaluator cannot tell a too-young vault from history we never indexed.
      expect(headTimestamp).not.toBeNull();
      expect(Date.parse(headTimestamp!)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    });

    it("resolves the deployment block recorded in the manifest", () => {
      expect(deploymentTimestamp).not.toBeNull();
      // Deployment necessarily precedes the window the observations cover.
      expect(Date.parse(deploymentTimestamp!)).toBeLessThan(Date.parse(headTimestamp!));
    });
  });
});
