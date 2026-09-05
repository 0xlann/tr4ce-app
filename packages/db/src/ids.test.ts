import { describe, expect, it } from "vitest";

import {
  assetId,
  protocolId,
  reorgInvalidationId,
  vaultCapabilityId,
  vaultFlowId,
  vaultId,
  vaultSnapshotId,
} from "./ids.js";
import { bytesToHex, hexToBytes } from "./schema/columns.js";

const BLOCK_HASH = "0x5954f35e3ceca3a086341e8a15b5ed63b3c906e8e9f316925a48fec6717c1940";
const TX_HASH = "0xc21c094783f3f466b48f65867d1e6248b2c1740c7730f29a78e15d21c6c18752";
const VAULT = "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61";

describe("derived identifiers", () => {
  it("produces a valid v5 uuid", () => {
    expect(vaultId(8453, VAULT)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is stable across calls", () => {
    // The whole point: a replay must land on the same primary key, or "replay produces identical
    // rows" degrades into "replay produces rows that agree if you ignore the id column".
    expect(vaultFlowId(8453, BLOCK_HASH, TX_HASH, 12, "deposit")).toBe(
      vaultFlowId(8453, BLOCK_HASH, TX_HASH, 12, "deposit"),
    );
  });

  it("ignores address checksumming", () => {
    // A checksummed and a lowercase spelling are the same vault. If they hashed differently the
    // registry would quietly hold two rows for one contract.
    expect(vaultId(8453, VAULT)).toBe(vaultId(8453, VAULT.toLowerCase()));
  });

  it("separates two kinds at the same log position", () => {
    expect(vaultFlowId(8453, BLOCK_HASH, TX_HASH, 12, "deposit")).not.toBe(
      vaultFlowId(8453, BLOCK_HASH, TX_HASH, 12, "share_transfer"),
    );
  });

  it("separates two log positions in one transaction", () => {
    // Never deduplicate on transaction hash alone: one deposit transaction emits both a Deposit
    // and a share mint.
    expect(vaultFlowId(8453, BLOCK_HASH, TX_HASH, 12, "deposit")).not.toBe(
      vaultFlowId(8453, BLOCK_HASH, TX_HASH, 13, "deposit"),
    );
  });

  it("separates the same transaction in two competing blocks", () => {
    const competing = `0x${"a".repeat(64)}`;

    expect(vaultFlowId(8453, BLOCK_HASH, TX_HASH, 12, "deposit")).not.toBe(
      vaultFlowId(8453, competing, TX_HASH, 12, "deposit"),
    );
  });

  it("separates the same address across chains", () => {
    expect(vaultId(8453, VAULT)).not.toBe(vaultId(1, VAULT));
    expect(assetId(8453, VAULT)).not.toBe(assetId(1, VAULT));
  });

  it("does not collide across entity kinds sharing a natural key", () => {
    expect(vaultId(8453, VAULT)).not.toBe(assetId(8453, VAULT));
  });

  it("keys a snapshot on producer schema version", () => {
    // A schema change re-derives the snapshot rather than overwriting the row an older report
    // already cites.
    expect(vaultSnapshotId(8453, VAULT, BLOCK_HASH, "1.0.0")).not.toBe(
      vaultSnapshotId(8453, VAULT, BLOCK_HASH, "2.0.0"),
    );
  });

  it("opens a new capability profile per effective block", () => {
    const vault = vaultId(8453, VAULT);

    expect(vaultCapabilityId(vault, "morpho-v2", "metamorpho-1.1", "50577041")).not.toBe(
      vaultCapabilityId(vault, "morpho-v2", "metamorpho-1.1", "50600000"),
    );
  });

  it("appends a distinct audit row per replacement block", () => {
    const subject = vaultId(8453, VAULT);

    expect(reorgInvalidationId("vault_flow", subject, BLOCK_HASH)).not.toBe(
      reorgInvalidationId("vault_flow", subject, `0x${"b".repeat(64)}`),
    );
  });

  it("keys protocols on slug alone", () => {
    expect(protocolId("morpho-blue")).toBe(protocolId("morpho-blue"));
    expect(protocolId("morpho-blue")).not.toBe(protocolId("yearn-v3"));
  });
});

describe("hex conversion", () => {
  it("round-trips through bytes", () => {
    expect(bytesToHex(hexToBytes(BLOCK_HASH))).toBe(BLOCK_HASH);
  });

  it("lowercases on the way out", () => {
    expect(bytesToHex(hexToBytes(VAULT))).toBe(VAULT.toLowerCase());
  });

  it("produces the byte lengths the schema checks", () => {
    expect(hexToBytes(VAULT)).toHaveLength(20);
    expect(hexToBytes(BLOCK_HASH)).toHaveLength(32);
  });

  it("rejects unprefixed hex", () => {
    // Silently accepting this is how an address ends up stored as the ASCII of its own spelling.
    expect(() => hexToBytes(VAULT.slice(2))).toThrow(TypeError);
  });

  it("rejects an odd number of digits", () => {
    expect(() => hexToBytes("0xabc")).toThrow(TypeError);
  });

  it("rejects non-hex payloads", () => {
    expect(() => hexToBytes("0xzz")).toThrow(TypeError);
  });
});
