import { usdToAtomic, atomicToUsd } from "./money";

/**
 * The spend policy is deterministic code, not a prompt. The model can ask to buy
 * anything; only this function decides whether money moves.
 */
export interface PolicyConfig {
  maxPerTransactionUsd: number;
  dailyBudgetUsd: number;
  approvalThresholdUsd: number;
  allowedMerchants: string[]; // host[:port], lowercase
  /**
   * Optional payee pinning: host[:port] → the only address that merchant may be paid at.
   * When a merchant has an entry here, a 402 asking for payment to any other address is denied.
   */
  merchantPayees?: Record<string, string>;
}

export interface PaymentIntent {
  merchant: string; // host[:port] of the resource being bought
  network: string; // CAIP-2, e.g. eip155:84532
  asset: string; // token contract address
  amountAtomic: bigint;
  payTo?: string; // payee address the merchant asked to be paid at
}

export interface PolicyContext {
  expectedNetwork: string;
  expectedAsset: string;
  spentTodayAtomic: bigint; // settled + in-flight spend since 00:00 UTC
}

export type PolicyDecision =
  | { outcome: "allow"; reason: string }
  | { outcome: "needs_approval"; reason: string }
  | { outcome: "deny"; rule: PolicyRule; reason: string };

export type PolicyRule =
  | "merchant_not_allowlisted"
  | "payee_mismatch"
  | "wrong_network"
  | "unsupported_asset"
  | "invalid_amount"
  | "per_transaction_cap"
  | "daily_budget";

export function evaluatePolicy(intent: PaymentIntent, cfg: PolicyConfig, ctx: PolicyContext): PolicyDecision {
  const merchant = intent.merchant.toLowerCase();
  if (!cfg.allowedMerchants.includes(merchant)) {
    return { outcome: "deny", rule: "merchant_not_allowlisted", reason: `${merchant} is not on the merchant allowlist` };
  }
  const pinned = cfg.merchantPayees?.[merchant];
  if (pinned !== undefined && intent.payTo?.toLowerCase() !== pinned.toLowerCase()) {
    return {
      outcome: "deny",
      rule: "payee_mismatch",
      reason: `${merchant} asked to be paid at ${intent.payTo ?? "(none)"}, but its registered payee is ${pinned}`,
    };
  }
  if (intent.network !== ctx.expectedNetwork) {
    return { outcome: "deny", rule: "wrong_network", reason: `merchant asked for ${intent.network}, wallet pays on ${ctx.expectedNetwork}` };
  }
  if (intent.asset.toLowerCase() !== ctx.expectedAsset.toLowerCase()) {
    return { outcome: "deny", rule: "unsupported_asset", reason: `asset ${intent.asset} is not USDC on this network` };
  }
  if (intent.amountAtomic <= 0n) {
    return { outcome: "deny", rule: "invalid_amount", reason: "amount must be positive" };
  }

  const cap = usdToAtomic(cfg.maxPerTransactionUsd);
  if (intent.amountAtomic > cap) {
    return {
      outcome: "deny",
      rule: "per_transaction_cap",
      reason: `${atomicToUsd(intent.amountAtomic)} exceeds the per-transaction cap of ${atomicToUsd(cap)}`,
    };
  }

  const budget = usdToAtomic(cfg.dailyBudgetUsd);
  if (ctx.spentTodayAtomic + intent.amountAtomic > budget) {
    const left = budget > ctx.spentTodayAtomic ? budget - ctx.spentTodayAtomic : 0n;
    return {
      outcome: "deny",
      rule: "daily_budget",
      reason: `${atomicToUsd(intent.amountAtomic)} exceeds the remaining daily budget of ${atomicToUsd(left)}`,
    };
  }

  const threshold = usdToAtomic(cfg.approvalThresholdUsd);
  if (intent.amountAtomic > threshold) {
    return {
      outcome: "needs_approval",
      reason: `${atomicToUsd(intent.amountAtomic)} is above the auto-approve threshold of ${atomicToUsd(threshold)}`,
    };
  }
  return { outcome: "allow", reason: `within policy (${atomicToUsd(intent.amountAtomic)} ≤ ${atomicToUsd(threshold)} auto-approve)` };
}
