/** USDC has 6 decimals. All money math is done in atomic units (bigint) to avoid float drift. */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

export function usdToAtomic(usd: number): bigint {
  // Round to the nearest micro-dollar; config values are human-entered like "0.10".
  return BigInt(Math.round(usd * Number(SCALE)));
}

export function atomicToUsd(atomic: bigint | string): string {
  const a = typeof atomic === "string" ? BigInt(atomic) : atomic;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `$${whole}.${frac.padEnd(2, "0")}`;
}
