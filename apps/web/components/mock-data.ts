export type MockVault = {
  id: string;
  name: string;
  protocol: string;
  network: string;
  address: string;
  status: "PASS" | "FAIL" | "UNKNOWN";
  completeness: number;
  historyDays: number;
  returnLabel: string;
  tvl: string;
  withdrawable: string;
  reason: string;
};

export const mockVaults: MockVault[] = [
  {
    id: "cedar",
    name: "Cedar USDC Vault",
    protocol: "Illustrative registry entry",
    network: "Ethereum",
    address: "0x7C31…A920",
    status: "PASS",
    completeness: 100,
    historyDays: 45,
    returnLabel: "+0.41% over 7 days",
    tvl: "4.20m USDC",
    withdrawable: "25,000 USDC",
    reason: "All five typed rules passed at the selected block.",
  },
  {
    id: "flint",
    name: "Flint USDC Vault",
    protocol: "Illustrative registry entry",
    network: "Ethereum",
    address: "0x96B2…104F",
    status: "FAIL",
    completeness: 100,
    historyDays: 61,
    returnLabel: "−0.18% over 7 days",
    tvl: "1.35m USDC",
    withdrawable: "18,000 USDC",
    reason: "TVL and observed share-value return are below this policy.",
  },
  {
    id: "moss",
    name: "Moss USDC Vault",
    protocol: "Illustrative registry entry",
    network: "Base",
    address: "0xA441…C2D8",
    status: "UNKNOWN",
    completeness: 82,
    historyDays: 90,
    returnLabel: "+0.62% over 7 days",
    tvl: "8.80m USDC",
    withdrawable: "—",
    reason: "Withdrawal capability is unresolved after an adapter mismatch.",
  },
];

export const reportRules = [
  ["Underlying asset", "is", "USDC", "USDC", "PASS", "asset() verified"],
  ["Minimum history", "≥", "30 days", "45 days", "PASS", "indexed snapshots cover window"],
  ["Minimum TVL", "≥", "2.00m USDC", "4.20m USDC", "PASS", "totalAssets() at block"],
  ["Observed share-value return", "≥", "0.00% / 7 days", "+0.41% / 7 days", "PASS", "exact integer-ratio calculation"],
  ["Withdrawable assets", "≥", "10,000 USDC", "25,000 USDC", "PASS", "maxWithdraw() capability verified"],
] as const;
