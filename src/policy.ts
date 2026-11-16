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
  /**
   * Optional task mandate: what THIS task may buy, declared by the person who set the task
   * (never by the model). When present, anything outside it is denied, even from an
   * allowlisted merchant at its registered payee and within every other limit.
   */
  mandate?: TaskMandate;
}

/** A purchase order for one task: which resources, at most how much each, at most how much in total. */
export interface TaskMandate {
  // resource = "host[:port]/path", query ignored. maxQuantity: how many times this task may buy it (unlimited if absent).
  items: { resource: string; maxUsd: number; maxQuantity?: number }[];
  maxTotalUsd: number;
}

/** "host[:port]/path" for a URL, lowercased host, no query. This is what a mandate item names. */
export function resourceKey(url: string): string {
  const u = new URL(url);
  return `${u.host.toLowerCase()}${u.pathname}`;
}

export interface PaymentIntent {
  merchant: string; // host[:port] of the resource being bought
  network: string; // CAIP-2, e.g. eip155:84532
  asset: string; // token contract address
  amountAtomic: bigint;
  payTo?: string; // payee address the merchant asked to be paid at
  resource?: string; // resourceKey() of what is being bought; required when a mandate is set
}

export interface PolicyContext {
  expectedNetwork: string;
  expectedAsset: string;
  spentTodayAtomic: bigint; // settled + in-flight spend since 00:00 UTC
  spentThisTaskAtomic?: bigint; // settled + in-flight spend in this run; used by the mandate total
  boughtThisTask?: number; // settled + in-flight purchases of this same resource in this run
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
  | "daily_budget"
  | "outside_mandate"
  | "over_mandate_price"
  | "mandate_total"
  | "mandate_quantity";

export function evaluatePolicy(intent: PaymentIntent, cfg: PolicyConfig, ctx: PolicyContext): PolicyDecision {
  const merchant = intent.merchant.toLowerCase();
  if (!cfg.allowedMerchants.includes(merchant)) {
    return { outcome: "deny", rule: "merchant_not_allowlisted", reason: `${merchant} is not on the merchant allowlist` };
  }
  const mandateItem = cfg.mandate ? cfg.mandate.items.find((i) => i.resource.toLowerCase() === (intent.resource ?? "").toLowerCase()) : undefined;
  if (cfg.mandate && !mandateItem) {
    return { outcome: "deny", rule: "outside_mandate", reason: `${intent.resource ?? "(unknown resource)"} is not part of this task's mandate` };
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

  if (cfg.mandate && mandateItem) {
    const itemMax = usdToAtomic(mandateItem.maxUsd);
    if (intent.amountAtomic > itemMax) {
      return {
        outcome: "deny",
        rule: "over_mandate_price",
        reason: `${atomicToUsd(intent.amountAtomic)} is above the mandate's ${atomicToUsd(itemMax)} for ${mandateItem.resource}`,
      };
    }
    if (mandateItem.maxQuantity !== undefined && (ctx.boughtThisTask ?? 0) >= mandateItem.maxQuantity) {
      return {
        outcome: "deny",
        rule: "mandate_quantity",
        reason: `this task may buy ${mandateItem.resource} at most ${mandateItem.maxQuantity} time(s)`,
      };
    }
    const total = usdToAtomic(cfg.mandate.maxTotalUsd);
    const spent = ctx.spentThisTaskAtomic ?? 0n;
    if (spent + intent.amountAtomic > total) {
      return {
        outcome: "deny",
        rule: "mandate_total",
        reason: `${atomicToUsd(intent.amountAtomic)} would take this task past its mandate total of ${atomicToUsd(total)} (spent ${atomicToUsd(spent)})`,
      };
    }
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

export interface PolicyCheck {
  rule: PolicyRule | "approval";
  ok: boolean;
  text: string; // plain English, for people watching the agent
}

/**
 * The same checks as evaluatePolicy, in the same order, written out in plain English
 * for the playground. Stops at the first failed check, like evaluatePolicy does.
 * Display only: evaluatePolicy is what decides (a test keeps the two in agreement).
 */
export function explainPolicy(intent: PaymentIntent, cfg: PolicyConfig, ctx: PolicyContext): PolicyCheck[] {
  const out: PolicyCheck[] = [];
  const amount = atomicToUsd(intent.amountAtomic);
  const merchant = intent.merchant.toLowerCase();
  const push = (rule: PolicyCheck["rule"], ok: boolean, yes: string, no: string) => {
    out.push({ rule, ok, text: ok ? yes : no });
    return ok;
  };

  if (!push("merchant_not_allowlisted", cfg.allowedMerchants.includes(merchant), "The shop is on your approved list.", "The shop is NOT on your approved list.")) return out;
  if (cfg.mandate) {
    const item = cfg.mandate.items.find((i) => i.resource.toLowerCase() === (intent.resource ?? "").toLowerCase());
    if (!push("outside_mandate", Boolean(item), "This item is on your order.", "This item is NOT on your order.")) return out;
  }
  const pinned = cfg.merchantPayees?.[merchant];
  if (pinned !== undefined) {
    const ok = intent.payTo?.toLowerCase() === pinned.toLowerCase();
    if (!push("payee_mismatch", ok, "The money goes to the shop's registered account.", `The shop asked for the money to go to a DIFFERENT account (${intent.payTo ?? "none"}).`)) return out;
  }
  if (!push("wrong_network", intent.network === ctx.expectedNetwork, "It's on the network your wallet uses.", `It asks for payment on a different network (${intent.network}).`)) return out;
  if (!push("unsupported_asset", intent.asset.toLowerCase() === ctx.expectedAsset.toLowerCase(), "It's priced in USDC.", "It asks for a currency other than USDC.")) return out;
  if (!push("invalid_amount", intent.amountAtomic > 0n, "The price is a valid amount.", "The price is not a valid amount.")) return out;
  const cap = usdToAtomic(cfg.maxPerTransactionUsd);
  if (!push("per_transaction_cap", intent.amountAtomic <= cap, `${amount} is within your ${atomicToUsd(cap)} limit per payment.`, `${amount} is MORE than your ${atomicToUsd(cap)} limit per payment.`)) return out;
  if (cfg.mandate) {
    const item = cfg.mandate.items.find((i) => i.resource.toLowerCase() === (intent.resource ?? "").toLowerCase())!;
    const itemMax = usdToAtomic(item.maxUsd);
    if (!push("over_mandate_price", intent.amountAtomic <= itemMax, `${amount} is within the ${atomicToUsd(itemMax)} you allowed for this item.`, `${amount} is MORE than the ${atomicToUsd(itemMax)} you allowed for this item.`)) return out;
    if (item.maxQuantity !== undefined) {
      const n = ctx.boughtThisTask ?? 0;
      if (!push("mandate_quantity", n < item.maxQuantity, `Bought ${n} of ${item.maxQuantity} allowed so far.`, `Already bought ${n} of the ${item.maxQuantity} allowed.`)) return out;
    }
    const total = usdToAtomic(cfg.mandate.maxTotalUsd);
    const spent = ctx.spentThisTaskAtomic ?? 0n;
    const left = total > spent ? total - spent : 0n;
    if (!push("mandate_total", spent + intent.amountAtomic <= total, `Fits in what's left of this order's budget (${atomicToUsd(left)} of ${atomicToUsd(total)}).`, `Doesn't fit in what's left of this order's budget (${atomicToUsd(left)} of ${atomicToUsd(total)}).`)) return out;
  }
  const budget = usdToAtomic(cfg.dailyBudgetUsd);
  const leftToday = budget > ctx.spentTodayAtomic ? budget - ctx.spentTodayAtomic : 0n;
  if (!push("daily_budget", ctx.spentTodayAtomic + intent.amountAtomic <= budget, `Fits in what's left of today's budget (${atomicToUsd(leftToday)} of ${atomicToUsd(budget)}).`, `Doesn't fit in what's left of today's budget (${atomicToUsd(leftToday)} of ${atomicToUsd(budget)}).`)) return out;
  const threshold = usdToAtomic(cfg.approvalThresholdUsd);
  out.push(
    intent.amountAtomic > threshold
      ? { rule: "approval", ok: false, text: `${amount} is above ${atomicToUsd(threshold)}, so a person has to approve it.` }
      : { rule: "approval", ok: true, text: `${amount} is under ${atomicToUsd(threshold)}, so it doesn't need a person's approval.` },
  );
  return out;
}
