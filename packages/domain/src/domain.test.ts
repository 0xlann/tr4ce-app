import { describe, expect, it } from "vitest";

import {
  addressSchema,
  baseUnitStringSchema,
  evidenceReportV1JsonSchema,
  evidenceReportV1Schema,
  policyRuleStatusSchema,
} from "./index.js";

const validReport = {
  schemaVersion: "1.0.0",
  reportId: "trc_01HZY6X2PZ9K5QGTFH2F1N7EJW",
  calculationVersion: "share-value-v1",
  vault: {
    chainId: 1,
    address: "0x1111111111111111111111111111111111111111",
    asset: "0x2222222222222222222222222222222222222222",
    assetSymbol: "USDC",
  },
  asOf: {
    blockNumber: "24500123",
    blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    timestamp: "2026-09-02T12:00:00.000Z",
  },
  generatedAt: "2026-09-02T12:00:05.000Z",
  observations: {
    shareValue: {
      oneShareBaseUnits: "1000000000000000000",
      assetsNow: "1052300",
      assetsAtStart: "1041000",
      windowDays: 30,
      returnBps: 108,
    },
    totalAssets: "4200000000000",
    netFlowAssets: "170000000000",
    maxWithdrawAssets: "10000000000",
  },
  policy: {
    version: 1,
    status: "PASS",
    rules: [],
  },
  provenance: [
    {
      sourceType: "indexed",
      chainId: 1,
      blockNumber: "24500123",
      blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reference: "vault_snapshot",
    },
  ],
  limitations: ["Observed share-value return is backward-looking."],
};

describe("@tr4ce/domain", () => {
  it("rejects malformed EVM addresses", () => {
    expect(() => addressSchema.parse("0x1234")).toThrow();
    expect(() => addressSchema.parse("0x111111111111111111111111111111111111111Z")).toThrow();
    expect(addressSchema.parse("0x1111111111111111111111111111111111111111")).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("rejects floating-point base units at the JSON boundary", () => {
    expect(() => baseUnitStringSchema.parse("1.25")).toThrow();
    expect(() => baseUnitStringSchema.parse(125)).toThrow();
    expect(baseUnitStringSchema.parse("1250000")).toBe("1250000");
  });

  it("rejects unknown policy statuses", () => {
    expect(() => policyRuleStatusSchema.parse("PENDING")).toThrow();
    expect(policyRuleStatusSchema.parse("UNKNOWN")).toBe("UNKNOWN");
  });

  it("rejects reports missing provenance", () => {
    const { provenance: _provenance, ...withoutProvenance } = validReport;

    expect(() => evidenceReportV1Schema.parse(withoutProvenance)).toThrow();
  });

  it("round-trips a valid report through JSON and publishes JSON Schema", () => {
    const report = evidenceReportV1Schema.parse(JSON.parse(JSON.stringify(validReport)));

    expect(report).toEqual(validReport);
    expect(evidenceReportV1JsonSchema).toMatchObject({
      $schema: expect.any(String),
      type: "object",
    });
  });
});
