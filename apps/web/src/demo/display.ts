const microUsdc = 1_000_000n;
const microUsdcPerMillion = 1_000_000_000_000n;
const integerFormatter = new Intl.NumberFormat("en-US");

export function formatUsdc(value: string): string {
  return `${integerFormatter.format(BigInt(value) / microUsdc)} USDC`;
}

export function formatUsdcMillions(value: string): string {
  const amount = BigInt(value);
  const whole = amount / microUsdcPerMillion;
  const fraction = ((amount % microUsdcPerMillion) * 100n) / microUsdcPerMillion;

  return `${whole}.${fraction.toString().padStart(2, "0")}m USDC`;
}
