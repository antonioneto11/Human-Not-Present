import "dotenv/config";
import type { Hex } from "viem";

/** Networks this project knows how to pay on. x402 v2 uses CAIP-2 ids. */
export const NETWORKS = {
  "base-sepolia": {
    caip2: "eip155:84532",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerTx: "https://sepolia.basescan.org/tx/",
    rpcUrl: "https://sepolia.base.org",
  },
  base: {
    caip2: "eip155:8453",
    usdc: "0x833589fCD6eDb6E08f4c7F094b7E8f2E1F43bdA02913",
    explorerTx: "https://basescan.org/tx/",
    rpcUrl: "https://mainnet.base.org",
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

function usd(name: string, fallback: string): number {
  const n = Number(env(name, fallback));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export function loadNetwork() {
  const name = env("NETWORK", "base-sepolia") as NetworkName;
  if (!(name in NETWORKS)) throw new Error(`NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`);
  return { name, ...NETWORKS[name] };
}

export function loadPolicyConfig() {
  return {
    maxPerTransactionUsd: usd("POLICY_MAX_PER_TX_USD", "1.00"),
    dailyBudgetUsd: usd("POLICY_DAILY_BUDGET_USD", "2.00"),
    approvalThresholdUsd: usd("POLICY_APPROVAL_THRESHOLD_USD", "0.10"),
    allowedMerchants: env("POLICY_ALLOWED_MERCHANTS", "localhost:4021")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

export function loadAgentWalletKey(): Hex {
  return env("AGENT_PRIVATE_KEY") as Hex;
}

export function loadMerchantConfig() {
  return {
    port: Number(env("MERCHANT_PORT", "4021")),
    payTo: env("MERCHANT_PAY_TO") as Hex,
    facilitatorUrl: env("FACILITATOR_URL", "https://x402.org/facilitator"),
  };
}

export const LEDGER_PATH = process.env.LEDGER_PATH ?? "data/ledger.jsonl";
