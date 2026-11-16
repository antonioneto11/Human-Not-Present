import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, type PolicyConfig } from "../src/policy";
import { usdToAtomic } from "../src/money";

const cfg: PolicyConfig = {
  maxPerTransactionUsd: 1,
  dailyBudgetUsd: 2,
  approvalThresholdUsd: 0.1,
  allowedMerchants: ["localhost:4021"],
};
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ctx = { expectedNetwork: "eip155:84532", expectedAsset: USDC, spentTodayAtomic: 0n };
const intent = (usd: number, over: Partial<Parameters<typeof evaluatePolicy>[0]> = {}) => ({
  merchant: "localhost:4021",
  network: "eip155:84532",
  asset: USDC,
  amountAtomic: usdToAtomic(usd),
  ...over,
});

test("small payment to allowlisted merchant is auto-approved", () => {
  assert.equal(evaluatePolicy(intent(0.01), cfg, ctx).outcome, "allow");
});

test("payment exactly at threshold is auto-approved; just above needs a human", () => {
  assert.equal(evaluatePolicy(intent(0.1), cfg, ctx).outcome, "allow");
  assert.equal(evaluatePolicy(intent(0.100001), cfg, ctx).outcome, "needs_approval");
});

test("over the per-transaction cap is denied, not escalated", () => {
  const d = evaluatePolicy(intent(25), cfg, ctx);
  assert.equal(d.outcome, "deny");
  assert.equal(d.outcome === "deny" && d.rule, "per_transaction_cap");
});

test("daily budget counts prior spend", () => {
  const d = evaluatePolicy(intent(0.5), cfg, { ...ctx, spentTodayAtomic: usdToAtomic(1.6) });
  assert.equal(d.outcome === "deny" && d.rule, "daily_budget");
  assert.equal(evaluatePolicy(intent(0.4), cfg, { ...ctx, spentTodayAtomic: usdToAtomic(1.6) }).outcome, "needs_approval");
});

test("unknown merchant, wrong chain, wrong token are all denied", () => {
  const rule = (i: ReturnType<typeof intent>) => {
    const d = evaluatePolicy(i, cfg, ctx);
    return d.outcome === "deny" ? d.rule : d.outcome;
  };
  assert.equal(rule(intent(0.01, { merchant: "evil.example" })), "merchant_not_allowlisted");
  assert.equal(rule(intent(0.01, { network: "eip155:8453" })), "wrong_network");
  assert.equal(rule(intent(0.01, { asset: "0x0000000000000000000000000000000000000001" })), "unsupported_asset");
  assert.equal(rule(intent(0)), "invalid_amount");
});

// ---- Task mandate ----
const mandated: PolicyConfig = {
  ...cfg,
  mandate: { items: [{ resource: "localhost:4021/api/weather", maxUsd: 0.05, maxQuantity: 1 }], maxTotalUsd: 0.1 },
};
const deny = (d: ReturnType<typeof evaluatePolicy>) => (d.outcome === "deny" ? d.rule : d.outcome);

test("mandate: an allowlisted, in-limit purchase outside the mandate is denied", () => {
  assert.equal(deny(evaluatePolicy(intent(0.01, { resource: "localhost:4021/api/addon" }), mandated, ctx)), "outside_mandate");
  assert.equal(deny(evaluatePolicy(intent(0.01), mandated, ctx)), "outside_mandate", "no resource → not in mandate");
});

test("mandate: in-mandate purchase is allowed; above the item price is denied", () => {
  assert.equal(evaluatePolicy(intent(0.05, { resource: "localhost:4021/api/weather" }), mandated, ctx).outcome, "allow");
  assert.equal(deny(evaluatePolicy(intent(0.06, { resource: "localhost:4021/api/weather" }), mandated, ctx)), "over_mandate_price");
});

test("mandate: quantity and task total are enforced", () => {
  const r = { resource: "localhost:4021/api/weather" };
  assert.equal(deny(evaluatePolicy(intent(0.01, r), mandated, { ...ctx, boughtThisTask: 1 })), "mandate_quantity");
  assert.equal(deny(evaluatePolicy(intent(0.05, r), mandated, { ...ctx, spentThisTaskAtomic: usdToAtomic(0.06) })), "mandate_total");
});

test("mandate does not loosen the base policy: allowlist and cap still apply", () => {
  const wide: PolicyConfig = { ...cfg, mandate: { items: [{ resource: "evil.test/x", maxUsd: 100 }, { resource: "localhost:4021/big", maxUsd: 100 }], maxTotalUsd: 100 } };
  assert.equal(deny(evaluatePolicy(intent(0.01, { merchant: "evil.test", resource: "evil.test/x" }), wide, ctx)), "merchant_not_allowlisted");
  assert.equal(deny(evaluatePolicy(intent(5, { resource: "localhost:4021/big" }), wide, ctx)), "per_transaction_cap");
});
