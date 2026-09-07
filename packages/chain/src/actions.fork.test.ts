import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { baseUsdcVaultManifest } from "@tr4ce/test-vaults";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { erc20Abi } from "./abis.js";
import { prepareDeposit, prepareRedeem } from "./prepare.js";
import { decodeDeposit, decodeRedeem, type ActionReceipt } from "./receipts.js";
import {
  bindingDigest,
  checkSignable,
  nextCallToSimulate,
  simulateCall,
} from "./simulate.js";
import { createChainClient, type ChainClient } from "./vault-reader.js";

/**
 * Prepared actions against a writable fork of Base.
 *
 * Anvil rather than pinned `eth_call`s, which is what Task 5 deliberately deferred to here: these
 * are state-changing operations, and the only way to know an approval-plus-deposit pair actually
 * works is to execute it and read the events back. TECH-STACK.md section 9 asks for exactly this —
 * "do not mock the EVM behavior that the product claims to verify".
 *
 * Gated on RPC_URL_BASE, since the fork is seeded from an archival provider.
 *
 * Transactions are sent with raw `eth_sendTransaction` over impersonated accounts rather than a
 * viem wallet client. That is not squeamishness: `abis.test.ts` fails if any non-test file in this
 * package names viem's wallet half, and writing the tests the same way keeps the boundary visible
 * instead of merely asserted.
 */

const rpcUrl = process.env["RPC_URL_BASE"];

/**
 * Anvil has to be installed as well as reachable.
 *
 * Checked rather than assumed: without this the suite fails on a spawn error that says nothing
 * about the missing tool, and the point of gating is that a machine without the prerequisites gets
 * a skip rather than a puzzle.
 */
const anvilAvailable = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

const FORK_BLOCK = 50_879_441n;
const PORT = 8556;
const FORK_URL = `http://127.0.0.1:${PORT}`;

const USDC = baseUsdcVaultManifest.canonicalAssets[0]!.address as Address;
/** USDC on Base keeps its balances mapping at slot 9 — located by probing the fork, not guessed. */
const USDC_BALANCE_SLOT = 9n;

const MORPHO = "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61" as Address;
const YEARN = "0xc3bd0a2193c8f027b82dde3611d18589ef3f62a9" as Address;

const ALICE = "0x00000000000000000000000000000000000000A1" as Address;
const BOB = "0x00000000000000000000000000000000000000B0" as Address;

const ONE_HUNDRED_USDC = 100_000_000n;

describe.skipIf(rpcUrl === undefined || !anvilAvailable).sequential("prepared actions on a Base fork", () => {
  let anvil: ChildProcess;
  let client: ChainClient;
  let capabilityVersion: string;

  beforeAll(async () => {
    anvil = spawn(
      "anvil",
      [
        "--fork-url",
        rpcUrl!,
        "--fork-block-number",
        FORK_BLOCK.toString(),
        "--port",
        String(PORT),
        "--silent",
      ],
      { stdio: "ignore" },
    );

    await waitForFork();

    client = createChainClient(FORK_URL);
    capabilityVersion = baseUsdcVaultManifest.vaults[0]!.evidence.rpcProviderKey ?? "test";

    // Gas for both accounts, and USDC for Alice. Bob is deliberately left with nothing so the
    // over-balance case is a real refusal rather than an arranged one.
    for (const account of [ALICE, BOB]) {
      await rpc("anvil_setBalance", [account, "0xde0b6b3a7640000"]);
    }

    await fundUsdc(ALICE, ONE_HUNDRED_USDC * 10n);
  }, 180_000);

  afterAll(() => {
    anvil?.kill();
  });

  // ---------------------------------------------------------------------------------------------

  describe("deposit preparation", () => {
    it("produces an exact approval and a deposit when allowance is short", async () => {
      const prepared = await prepareDeposit(client, {
        vault: MORPHO,
        asset: USDC,
        owner: ALICE,
        receiver: ALICE,
        assets: ONE_HUNDRED_USDC,
      });

      expect(prepared.ok).toBe(true);

      if (!prepared.ok) return;

      expect(prepared.value.calls.map((call) => call.kind)).toEqual(["approve", "deposit"]);
      expect(prepared.value.allowance).toBe(0n);

      /*
       * The approval amount, decoded from the calldata rather than trusted from the request. This
       * is PRD TR-F-034 checked at the only place it can be broken: an unlimited allowance would be
       * type(uint256).max, and this asserts the exact figure instead of merely "not max".
       */
      const approve = prepared.value.calls[0]!;

      expect(approve.to.toLowerCase()).toBe(USDC.toLowerCase());
      expect(approve.data).toBe(
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [MORPHO, ONE_HUNDRED_USDC],
        }),
      );
      expect(prepared.value.previewedShares).toBeGreaterThan(0n);
    });

    it("omits the approval once the allowance already covers the amount", async () => {
      /*
       * The other arm of "if allowance is insufficient" (SMART-CONTRACT.md:134). A second approve
       * would be a transaction the user pays for and gains nothing from, and testing only the
       * two-call arm would leave the branch that decides it unexercised.
       */
      await send(ALICE, USDC, encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [YEARN, ONE_HUNDRED_USDC],
      }));

      const prepared = await prepareDeposit(client, {
        vault: YEARN,
        asset: USDC,
        owner: ALICE,
        receiver: ALICE,
        assets: ONE_HUNDRED_USDC,
      });

      expect(prepared.ok).toBe(true);

      if (!prepared.ok) return;

      expect(prepared.value.calls.map((call) => call.kind)).toEqual(["deposit"]);
      expect(prepared.value.allowance).toBe(ONE_HUNDRED_USDC);
    });

    it("refuses a vault that does not hold the asset it was asked about", async () => {
      // Identity is what the contract returns, never what our registry says (SMART-CONTRACT.md
      // section 2). Passing the wrong asset must fail before any calldata exists.
      const prepared = await prepareDeposit(client, {
        vault: MORPHO,
        asset: YEARN, // a vault address standing in for an asset: definitely not USDC
        owner: ALICE,
        receiver: ALICE,
        assets: ONE_HUNDRED_USDC,
      });

      expect(prepared.ok).toBe(false);

      if (prepared.ok) return;

      expect(prepared.failure.code).toBe("ASSET_MISMATCH");
    });

    it("refuses an amount larger than the balance", async () => {
      const prepared = await prepareDeposit(client, {
        vault: MORPHO,
        asset: USDC,
        owner: BOB,
        receiver: BOB,
        assets: ONE_HUNDRED_USDC,
      });

      expect(prepared.ok).toBe(false);

      if (prepared.ok) return;

      expect(prepared.failure).toMatchObject({
        code: "INSUFFICIENT_BALANCE",
        required: ONE_HUNDRED_USDC,
      });
    });

    it("refuses a zero amount before touching the chain", async () => {
      const prepared = await prepareDeposit(client, {
        vault: MORPHO,
        asset: USDC,
        owner: ALICE,
        receiver: ALICE,
        assets: 0n,
      });

      expect(prepared.ok && false).toBe(false);
      expect(prepared.ok ? null : prepared.failure.code).toBe("AMOUNT_NOT_POSITIVE");
    });
  });

  describe("executing the prepared calls", () => {
    it("deposits, and the receipt reports shares rather than the preview", async () => {
      /*
       * The full path: prepare, simulate, execute, decode. What makes it worth running against a
       * fork is the last step — SMART-CONTRACT.md section 4 requires actual shares to come from
       * execution evidence and not be "replaced by preview", and only a real receipt can show that
       * the two are compared rather than conflated.
       */
      const prepared = await prepareDeposit(client, {
        vault: MORPHO,
        asset: USDC,
        owner: ALICE,
        receiver: ALICE,
        assets: ONE_HUNDRED_USDC,
      });

      expect(prepared.ok).toBe(true);

      if (!prepared.ok) return;

      /*
       * Simulated one call at a time, each against the state its predecessor left behind.
       *
       * The first draft of this test simulated both calls up front and the deposit failed — the
       * approval had not landed, so the vault had no allowance to pull from. That is the chain
       * being right and the test being wrong, and `nextCallToSimulate` now states the rule rather
       * than leaving the next person to rediscover it.
       */
      let receipt: ActionReceipt | null = null;
      let sent = 0;

      while (sent < prepared.value.calls.length) {
        const call = nextCallToSimulate(prepared.value.calls, sent)!;
        const block = await client.getBlock();

        const simulation = await simulateCall(client, {
          account: ALICE,
          call,
          blockNumber: block.number,
          blockHash: block.hash,
          blockTimestamp: Number(block.timestamp),
          capabilityVersion,
        });

        expect(simulation.status).toBe("SUCCEEDED");
        expect(simulation.gasEstimate).toBeGreaterThan(0n);

        receipt = await send(ALICE, call.to, call.data);
        sent += 1;
      }

      expect(nextCallToSimulate(prepared.value.calls, sent)).toBeNull();
      expect(receipt?.status).toBe("success");

      const outcome = decodeDeposit(receipt!, MORPHO, ALICE, prepared.value.previewedShares);

      expect(outcome.actualShares).not.toBeNull();
      expect(outcome.actualShares).toBeGreaterThan(0n);
      expect(outcome.actualAssets).toBe(ONE_HUNDRED_USDC);
      // The comparison the product shows, not a substitution. Equal here, and the delta is what
      // makes that a finding rather than an assumption.
      expect(outcome.shareDelta).toBe(outcome.actualShares! - prepared.value.previewedShares);
    });

    it("refuses to redeem a full share balance the vault will not honour", async () => {
      /*
       * A finding, not an arranged case: on this Morpho vault `maxRedeem` sits fractionally below
       * the owner's own share balance — roughly one part in a hundred million, from the rounding
       * that protects the vault. A "redeem everything" button wired to `balanceOf` would therefore
       * build a transaction the chain refuses.
       *
       * The limit check catches it before any calldata exists.
       */
      const balance = await shareBalanceOf(MORPHO, ALICE);
      const limit = await maxRedeemOf(MORPHO, ALICE);

      expect(balance).toBeGreaterThan(0n);
      expect(limit).toBeLessThan(balance);

      const prepared = await prepareRedeem(client, {
        vault: MORPHO,
        owner: ALICE,
        receiver: ALICE,
        shares: balance,
      });

      expect(prepared.ok).toBe(false);
      expect(prepared.ok ? null : prepared.failure).toMatchObject({
        code: "LIMIT_EXCEEDED",
        requested: balance,
        limit,
      });
    });

    it("redeems what the vault says it will honour", async () => {
      const limit = await maxRedeemOf(MORPHO, ALICE);

      const prepared = await prepareRedeem(client, {
        vault: MORPHO,
        owner: ALICE,
        receiver: ALICE,
        shares: limit,
      });

      expect(prepared.ok).toBe(true);

      if (!prepared.ok) return;

      // One call. A redemption burns the owner's own shares, so no allowance is involved.
      expect(prepared.value.calls.map((call) => call.kind)).toEqual(["redeem"]);

      const receipt = await send(ALICE, prepared.value.calls[0]!.to, prepared.value.calls[0]!.data);

      expect(receipt.status).toBe("success");

      const outcome = decodeRedeem(receipt, MORPHO, ALICE, prepared.value.previewedAssets);

      expect(outcome.actualAssets).not.toBeNull();
      expect(outcome.actualShares).toBe(limit);
      // The comparison the product shows. Equal here, and the delta is what makes that a finding
      // rather than an assumption.
      expect(outcome.assetDelta).toBe(outcome.actualAssets! - prepared.value.previewedAssets);
    });

    it("reports a revert as a failed simulation with no gas figure", async () => {
      // Bob holds no USDC, so the deposit reverts. A gas estimate here would be a number for a
      // call that never happened.
      const call = {
        chainId: 8453,
        to: MORPHO,
        data: encodeFunctionData({
          abi: [
            {
              type: "function",
              name: "deposit",
              stateMutability: "nonpayable",
              inputs: [
                { name: "assets", type: "uint256" },
                { name: "receiver", type: "address" },
              ],
              outputs: [{ name: "shares", type: "uint256" }],
            },
          ] as const,
          functionName: "deposit",
          args: [ONE_HUNDRED_USDC, BOB],
        }),
        value: "0",
        kind: "deposit" as const,
      };

      const block = await client.getBlock();
      const simulation = await simulateCall(client, {
        account: BOB,
        call,
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: Number(block.timestamp),
        capabilityVersion,
      });

      expect(simulation.status).toBe("FAILED");
      expect(simulation.gasEstimate).toBeNull();
    });
  });

  describe("the simulation binding, against a chain that moved", () => {
    it("stops being signable once the block budget is spent", async () => {
      /*
       * The block bound proven on a chain that actually advanced, rather than by handing
       * `checkSignable` a larger number. Base produces a block every two seconds, so three blocks
       * is roughly six — the bound that fires in practice, and the one a clock-only test misses.
       */
      const prepared = await prepareDeposit(client, {
        vault: YEARN,
        asset: USDC,
        owner: ALICE,
        receiver: ALICE,
        assets: 1_000_000n,
      });

      expect(prepared.ok).toBe(true);

      if (!prepared.ok) return;

      const block = await client.getBlock();
      const simulation = await simulateCall(client, {
        account: ALICE,
        call: prepared.value.calls[0]!,
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: Number(block.timestamp),
        capabilityVersion,
      });

      const stillFresh = checkSignable({
        simulation,
        current: simulation.binding,
        currentBlock: block.number,
        now: new Date(Number(block.timestamp) * 1000),
      });

      expect(stillFresh).toEqual({ signable: true });

      // Four blocks: one past the budget.
      await rpc("anvil_mine", ["0x4"]);

      const moved = await client.getBlock();

      expect(moved.number).toBeGreaterThan(simulation.expiresAtBlock);
      expect(
        checkSignable({
          simulation,
          current: simulation.binding,
          currentBlock: moved.number,
          now: new Date(Number(block.timestamp) * 1000),
        }),
      ).toEqual({ signable: false, reason: "BLOCK_BUDGET_SPENT" });
    });

    it("stops being signable when the account changes", async () => {
      // PRD TR-F-035. The wallet switching accounts is the everyday version of this, and the
      // binding is what turns it into a refusal rather than a transaction from the wrong address.
      const block = await client.getBlock();
      const call = {
        chainId: 8453,
        to: USDC,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [MORPHO, 1_000_000n],
        }),
        value: "0",
        kind: "approve" as const,
      };

      const simulation = await simulateCall(client, {
        account: ALICE,
        call,
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: Number(block.timestamp),
        capabilityVersion,
      });

      expect(
        checkSignable({
          simulation,
          current: { ...simulation.binding, account: BOB },
          currentBlock: block.number,
          now: new Date(Number(block.timestamp) * 1000),
        }),
      ).toEqual({ signable: false, reason: "BINDING_CHANGED" });
    });

    it("binds the calldata, not merely the target", async () => {
      // Same vault, same account, different amount. Without the data hash in the binding this
      // would still look fresh, and a user could sign an amount they never reviewed.
      const block = await client.getBlock();
      const forOneUsdc = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [MORPHO, 1_000_000n],
      });
      const forTenThousand = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [MORPHO, 10_000_000_000n],
      });

      const simulation = await simulateCall(client, {
        account: ALICE,
        call: { chainId: 8453, to: USDC, data: forOneUsdc, value: "0", kind: "approve" },
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: Number(block.timestamp),
        capabilityVersion,
      });

      const swapped = { ...simulation.binding, dataHash: keccak256(forTenThousand) };

      expect(bindingDigest(swapped)).not.toBe(bindingDigest(simulation.binding));
      expect(
        checkSignable({
          simulation,
          current: swapped,
          currentBlock: block.number,
          now: new Date(Number(block.timestamp) * 1000),
        }),
      ).toEqual({ signable: false, reason: "BINDING_CHANGED" });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Fork plumbing. Raw JSON-RPC: no wallet client anywhere in this package, tests included.
  // ---------------------------------------------------------------------------------------------

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(FORK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

    const payload = (await response.json()) as { result?: T; error?: { message: string } };

    if (payload.error) {
      throw new Error(`${method}: ${payload.error.message}`);
    }

    return payload.result as T;
  }

  async function waitForFork(): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        await rpc("eth_blockNumber", []);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    throw new Error("Anvil did not become reachable.");
  }

  /** Write a USDC balance directly. The slot was located by probing the fork, not assumed. */
  async function fundUsdc(account: Address, amount: bigint): Promise<void> {
    const slot = keccak256(
      `0x${account.slice(2).toLowerCase().padStart(64, "0")}${USDC_BALANCE_SLOT.toString(16).padStart(64, "0")}` as Hex,
    );

    await rpc("anvil_setStorageAt", [
      USDC,
      slot,
      `0x${amount.toString(16).padStart(64, "0")}`,
    ]);
  }

  const balanceAbi = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
    {
      type: "function",
      name: "maxRedeem",
      stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;

  const shareBalanceOf = (vault: Address, account: Address) =>
    client.readContract({ address: vault, abi: balanceAbi, functionName: "balanceOf", args: [account] });

  const maxRedeemOf = (vault: Address, account: Address) =>
    client.readContract({ address: vault, abi: balanceAbi, functionName: "maxRedeem", args: [account] });

  async function send(from: Address, to: Address, data: Hex): Promise<ActionReceipt> {
    await rpc("anvil_impersonateAccount", [from]);

    const hash = await rpc<Hex>("eth_sendTransaction", [{ from, to, data, gas: "0x7a1200" }]);

    await rpc("anvil_stopImpersonatingAccount", [from]);

    const receipt = await client.waitForTransactionReceipt({ hash });

    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed,
      logs: receipt.logs,
    };
  }
});
