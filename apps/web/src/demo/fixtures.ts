import {
  evidenceReportV1Schema,
  policyV1Schema,
  preparedActionV1Schema,
  type EvidenceReportV1,
  type PolicyRuleResult,
  type PolicyRuleStatus,
  type PolicyV1,
  type PreparedActionV1,
} from "@tr4ce/domain";
import type { PolicyPreset, VaultSummary } from "./types";

export type { PolicyPreset, VaultSummary } from "./types";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER = "0x1111111111111111111111111111111111111111";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const AS_OF = {
  blockNumber: "50879897",
  blockHash: HASH_A,
  timestamp: "2026-09-04T12:00:00.000Z",
};

const policies: Record<PolicyPreset, PolicyV1> = {
  strict: policyV1Schema.parse({
    version: 1,
    underlyingAssets: ["USDC"],
    minHistoryDays: 30,
    minTvlAssets: "5000000000000",
    minObservedReturnBps: { windowDays: 7, value: 100 },
    minWithdrawableAssets: { owner: OWNER, value: "25000000000" },
  }),
  balanced: policyV1Schema.parse({
    version: 1,
    underlyingAssets: ["USDC"],
    minHistoryDays: 30,
    minTvlAssets: "2000000000000",
    minObservedReturnBps: { windowDays: 7, value: 0 },
    minWithdrawableAssets: { owner: OWNER, value: "10000000000" },
  }),
  lenient: policyV1Schema.parse({
    version: 1,
    underlyingAssets: ["USDC"],
    minHistoryDays: 14,
    minTvlAssets: "1000000000000",
    minObservedReturnBps: { windowDays: 7, value: -50 },
    minWithdrawableAssets: { owner: OWNER, value: "5000000000" },
  }),
};

const rule = (
  key: PolicyRuleResult["key"],
  status: PolicyRuleStatus,
  threshold: string,
  observedValue: string | null,
  reasonCodes: PolicyRuleResult["reasonCodes"] = [],
): PolicyRuleResult => ({
  key,
  status,
  threshold,
  observedValue,
  evidenceReferences: ["vault_snapshot.end"],
  reasonCodes,
});

function rulesFor(status: PolicyRuleStatus): PolicyRuleResult[] {
  const finalStatus = status === "PASS" ? "PASS" : status;

  return [
    rule("underlyingAsset", "PASS", "USDC", "USDC"),
    rule("minimumHistory", "PASS", "30 days", "45 days"),
    rule("minimumTvl", finalStatus, "2,000,000 USDC", "4,200,000 USDC", status === "FAIL" ? ["MISSING_OBSERVATION"] : []),
    rule("minimumObservedReturn", finalStatus, "0.00% / 7 days", "+0.41% / 7 days", status === "FAIL" ? ["STALE_EVIDENCE"] : []),
    rule(
      "minimumWithdrawableAssets",
      status === "UNKNOWN" ? "UNKNOWN" : "PASS",
      "10,000 USDC",
      status === "UNKNOWN" ? null : "25,000 USDC",
      status === "UNKNOWN" ? ["AMBIGUOUS_CAPABILITY"] : [],
    ),
  ];
}

function report(
  id: string,
  vault: string,
  status: PolicyRuleStatus,
  options: { returnBps: number; totalAssets: string; netFlowAssets: string; maxWithdrawAssets: string | null },
): EvidenceReportV1 {
  return evidenceReportV1Schema.parse({
    schemaVersion: "1.0.0",
    reportId: id,
    calculationVersion: "share-value-v1",
    vault: { chainId: 8453, address: vault, asset: BASE_USDC, assetSymbol: "USDC" },
    asOf: AS_OF,
    generatedAt: "2026-09-05T00:00:00.000Z",
    observations: {
      shareValue: {
        oneShareBaseUnits: "1000000000000000000",
        assetsNow: "1052300",
        assetsAtStart: "1048000",
        windowDays: 7,
        returnBps: options.returnBps,
      },
      totalAssets: options.totalAssets,
      netFlowAssets: options.netFlowAssets,
      maxWithdrawAssets: options.maxWithdrawAssets,
    },
    policy: { version: 1, status, rules: rulesFor(status) },
    provenance: [
      { sourceType: "indexed", chainId: 8453, blockNumber: "50879897", blockHash: HASH_A, reference: "vault_snapshot.end" },
      { sourceType: "indexed", chainId: 8453, blockNumber: "50577041", blockHash: HASH_B, reference: "vault_snapshot.start" },
      { sourceType: "rpc", chainId: 8453, blockNumber: "50879900", blockHash: HASH_B, reference: "account_limits.maxWithdraw" },
    ],
    limitations: status === "UNKNOWN"
      ? [
          "Illustrative evidence only. Observed share-value return is backward-looking and is not a forecast.",
          "Withdrawal capacity could not be verified because adapter semantics are unresolved.",
        ]
      : ["Illustrative evidence only. Observed share-value return is backward-looking and is not a forecast."],
  });
}

const vaultMeta = [
  {
    id: "gauntlet-usdc-prime",
    name: "Gauntlet USDC Prime",
    protocol: "Morpho Blue",
    network: "Base",
    address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
    completeness: 100,
  },
  {
    id: "yearn-og-usdc",
    name: "Yearn OG USDC",
    protocol: "Morpho Blue",
    network: "Base",
    address: "0xef417a2512C5a41f69AE4e021648b69a7CdE5D03",
    completeness: 100,
  },
  {
    id: "morpho-yearn-compounder",
    name: "Morpho Yearn Compounder",
    protocol: "Yearn V3",
    network: "Base",
    address: "0xF115C134c23C7A05FBD489A8bE3116EbF54B0D9f",
    completeness: 82,
  },
] as const;

const reportsByPreset: Record<PolicyPreset, readonly VaultSummary[]> = {
  balanced: [
    { ...vaultMeta[0], report: report("trc_gauntletBalanced01", vaultMeta[0].address, "PASS", { returnBps: 41, totalAssets: "4200000000000", netFlowAssets: "170000000000", maxWithdrawAssets: "25000000000" }) },
    { ...vaultMeta[1], report: report("trc_yearnBalanced01", vaultMeta[1].address, "FAIL", { returnBps: -18, totalAssets: "1350000000000", netFlowAssets: "-24000000000", maxWithdrawAssets: "18000000000" }) },
    { ...vaultMeta[2], report: report("trc_morphoBalanced01", vaultMeta[2].address, "UNKNOWN", { returnBps: 62, totalAssets: "8800000000000", netFlowAssets: "90000000000", maxWithdrawAssets: null }) },
  ],
  strict: [
    { ...vaultMeta[0], report: report("trc_gauntletStrict01", vaultMeta[0].address, "FAIL", { returnBps: 41, totalAssets: "4200000000000", netFlowAssets: "170000000000", maxWithdrawAssets: "25000000000" }) },
    { ...vaultMeta[1], report: report("trc_yearnStrict01", vaultMeta[1].address, "FAIL", { returnBps: -18, totalAssets: "1350000000000", netFlowAssets: "-24000000000", maxWithdrawAssets: "18000000000" }) },
    { ...vaultMeta[2], report: report("trc_morphoStrict01", vaultMeta[2].address, "UNKNOWN", { returnBps: 62, totalAssets: "8800000000000", netFlowAssets: "90000000000", maxWithdrawAssets: null }) },
  ],
  lenient: [
    { ...vaultMeta[0], report: report("trc_gauntletLenient01", vaultMeta[0].address, "PASS", { returnBps: 41, totalAssets: "4200000000000", netFlowAssets: "170000000000", maxWithdrawAssets: "25000000000" }) },
    { ...vaultMeta[1], report: report("trc_yearnLenient01", vaultMeta[1].address, "PASS", { returnBps: -18, totalAssets: "1350000000000", netFlowAssets: "-24000000000", maxWithdrawAssets: "18000000000" }) },
    { ...vaultMeta[2], report: report("trc_morphoLenient01", vaultMeta[2].address, "UNKNOWN", { returnBps: 62, totalAssets: "8800000000000", netFlowAssets: "90000000000", maxWithdrawAssets: null }) },
  ],
};

const preparedAction = preparedActionV1Schema.parse({
  schemaVersion: "1.0.0",
  actionId: "act_gauntletDeposit01",
  operation: "deposit",
  vault: vaultMeta[0].address,
  asset: BASE_USDC,
  owner: OWNER,
  receiver: OWNER,
  amount: "10000000000",
  // Both calls, in signing order. The UI already said "exact approval then direct deposit"; until
  // the contract became an array it could only show the second one.
  transactions: [
    {
      chainId: 8453,
      to: BASE_USDC,
      // approve(vault, 10000000000) — the exact amount, never unlimited (PRD TR-F-034).
      data: "0x095ea7b3000000000000000000000000ee8f4ec5672f09119b96ab6fb59c27e1b7e44b6100000000000000000000000000000000000000000000000000000002540be400",
      value: "0",
      kind: "approve",
    },
    {
      chainId: 8453,
      to: vaultMeta[0].address,
      // deposit(10000000000, owner)
      data: "0x6e553f6500000000000000000000000000000000000000000000000000000002540be4000000000000000000000000001111111111111111111111111111111111111111",
      value: "0",
      kind: "deposit",
    },
  ],
  // Shares previewDeposit expects for this amount. A preview, never a promise.
  previewed: "9784120000",
  simulation: {
    status: "SUCCEEDED",
    blockNumber: "50879900",
    blockHash: HASH_B,
    expiresAt: "2026-09-05T00:01:00.000Z",
    gasEstimate: "182000",
    reasonCodes: [],
  },
});

export function getPolicyPreset(preset: PolicyPreset): PolicyV1 {
  return policies[preset];
}

export function getVaultSummaries(preset: PolicyPreset): readonly VaultSummary[] {
  return reportsByPreset[preset];
}

export function getReport(id: string, preset: PolicyPreset = "balanced"): EvidenceReportV1 | undefined {
  return reportsByPreset[preset].find((vault) => vault.id === id || vault.report.reportId === id)?.report;
}

export function getPreparedAction(id: string): PreparedActionV1 | undefined {
  return id === preparedAction.actionId ? preparedAction : undefined;
}

export const demoActionId = preparedAction.actionId;
