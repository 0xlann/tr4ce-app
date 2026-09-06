import { usability } from "@tr4ce/evidence";
import { describe, expect, it } from "vitest";

import { classifyCapabilities, ownerHoldsShares } from "./capabilities.js";
import type { VaultReadResults } from "./vault-reader.js";

const ok = (value: bigint) => ({ ok: true, value }) as const;
const failed = (revertData: string | null = null) =>
  ({ ok: false, revertData, message: "execution reverted" }) as const;

const results = (overrides: Partial<VaultReadResults> = {}): VaultReadResults =>
  ({
    vault: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
    blockNumber: 50_879_441n,
    asset: { ok: true, value: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    decimals: ok(18n),
    totalAssets: ok(417_000_000_000n),
    totalSupply: ok(400_000_000_000n),
    convertToAssets: ok(1_052_300n),
    maxWithdraw: ok(50_000_000_000n),
    maxRedeem: ok(40_000_000_000n),
    previewDeposit: ok(950_000n),
    previewRedeem: ok(1_052_300n),
    ownerShares: ok(1_000_000n),
    ...overrides,
  }) as VaultReadResults;

const classify = (overrides: Partial<VaultReadResults> = {}, holds = true) =>
  classifyCapabilities({
    results: results(overrides),
    atBlock: "50879441",
    ownerHoldsShares: holds,
  });

const probeFor = (probes: ReturnType<typeof classify>, method: string) =>
  probes.find((probe) => probe.method === method)!;

describe("successful reads", () => {
  it("marks an answered call supported and keeps the raw return", () => {
    // The raw hex is the evidence; the status is only an interpretation of it.
    const probe = probeFor(classify(), "totalAssets");

    expect(probe.status).toBe("supported");
    expect(probe.rawResult).toBe(`0x${(417_000_000_000n).toString(16).padStart(64, "0")}`);
    expect(probe.reasonCode).toBeNull();
  });

  it("left-pads an address return to a full word", () => {
    expect(probeFor(classify(), "asset").rawResult).toBe(
      `0x${"833589fcd6edb6e08f4c7c32d4f71b54bda02913".padStart(64, "0")}`,
    );
  });
});

describe("reverts", () => {
  it("records a revert as a revert, with its payload", () => {
    const probe = probeFor(classify({ maxWithdraw: failed("0xdeadbeef") }), "maxWithdraw");

    expect(probe.status).toBe("reverted");
    expect(probe.revertData).toBe("0xdeadbeef");
    expect(probe.reasonCode).toBe("CALL_REVERTED");
    expect(probe.rawResult).toBeNull();
  });

  it("does not let one revert affect the other methods", () => {
    // A vault where maxWithdraw reverts must still report its totalAssets.
    const probes = classify({ maxWithdraw: failed() });

    expect(probeFor(probes, "totalAssets").status).toBe("supported");
  });
});

describe("the non-standard zero", () => {
  it("flags a zero capacity for an owner who holds shares", () => {
    /*
     * Morpho Vault V2 documents maxWithdraw returning zero for an owner who demonstrably holds
     * shares. Recorded as its own status so it can never be read as verified zero capacity, with
     * the raw zero preserved so the claim stays checkable.
     */
    const probe = probeFor(classify({ maxWithdraw: ok(0n) }, true), "maxWithdraw");

    expect(probe.status).toBe("nonstandard_zero");
    expect(probe.reasonCode).toBe("AMBIGUOUS_CAPABILITY");
    expect(probe.rawResult).toBe(`0x${"0".repeat(64)}`);
    expect(probe.note).toContain("capacity unresolved");
  });

  it("treats a zero for an owner with no shares as simply correct", () => {
    // Nothing deposited, nothing withdrawable. That is an answer, not an anomaly.
    const probe = probeFor(classify({ maxWithdraw: ok(0n) }, false), "maxWithdraw");

    expect(probe.status).toBe("supported");
  });

  it("never becomes usable evidence downstream", () => {
    // The reducer in @tr4ce/evidence is what enforces this, and it is not duplicated here.
    const probe = probeFor(classify({ maxWithdraw: ok(0n) }, true), "maxWithdraw");

    expect(usability(probe.status)).toBe("unknown");
  });

  it("applies to maxRedeem on the same terms", () => {
    expect(probeFor(classify({ maxRedeem: ok(0n) }, true), "maxRedeem").status).toBe(
      "nonstandard_zero",
    );
  });

  it("never invents a positive value in place of the zero", () => {
    // PRD section 8.3: an adapter must not turn a documented non-standard zero into a fabricated
    // positive value.
    const probe = probeFor(classify({ maxWithdraw: ok(0n) }, true), "maxWithdraw");

    expect(BigInt(probe.rawResult!)).toBe(0n);
  });
});

describe("account-scoped methods that were never called", () => {
  it("omits them rather than calling them unsupported", () => {
    // A method nobody asked about has no status. Recording "unsupported" would assert a fact the
    // reads never established.
    const probes = classify({ maxWithdraw: null, maxRedeem: null, ownerShares: null });

    expect(probes.find((probe) => probe.method === "maxWithdraw")).toBeUndefined();
    expect(probes.find((probe) => probe.method === "maxRedeem")).toBeUndefined();
    expect(probes.find((probe) => probe.method === "totalAssets")).toBeDefined();
  });
});

describe("ownerHoldsShares", () => {
  it("is true only for a positive balance", () => {
    expect(ownerHoldsShares(results({ ownerShares: ok(1n) }))).toBe(true);
    expect(ownerHoldsShares(results({ ownerShares: ok(0n) }))).toBe(false);
  });

  it("answers no when the balance could not be read", () => {
    // An unreadable balance must not be guessed into a "yes", which would turn an honest zero
    // capacity into a spurious ambiguity.
    expect(ownerHoldsShares(results({ ownerShares: failed() }))).toBe(false);
    expect(ownerHoldsShares(results({ ownerShares: null }))).toBe(false);
  });
});
