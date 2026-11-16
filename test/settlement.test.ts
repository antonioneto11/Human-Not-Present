/** The simulator must reject everything a real facilitator would reject. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SIM_NETWORK, SimulatedFacilitator, SimulatedUsdcLedger } from "../src/settlement";
import { usdToAtomic } from "../src/money";

const PAYEE = "0x1111111111111111111111111111111111111111";
const req = (amount = "10000", payTo = PAYEE): PaymentRequirements => ({
  scheme: "exact",
  network: SIM_NETWORK.caip2 as `${string}:${string}`,
  asset: SIM_NETWORK.usdc,
  amount,
  payTo,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
});

function setup(balanceUsd = 5) {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const ledger = new SimulatedUsdcLedger(join(mkdtempSync(join(tmpdir(), "sim-")), "chain.json"), SIM_NETWORK.usdc, {
    [address]: usdToAtomic(balanceUsd),
  });
  const fac = new SimulatedFacilitator(SIM_NETWORK.caip2, SIM_NETWORK.chainId);
  fac.registerPayer(address, ledger);
  const client = new x402Client().register(SIM_NETWORK.caip2 as `${string}:${string}`, new ExactEvmScheme(privateKeyToAccount(key)));
  const sign = (r: PaymentRequirements) => client.createPaymentPayload({ x402Version: 2, resource: { url: "http://x/y" } as never, accepts: [r] });
  return { address, ledger, fac, sign };
}

test("valid payment verifies and settles with a sim_ receipt (never a tx hash)", async () => {
  const { fac, sign, ledger, address } = setup();
  const p = await sign(req());
  assert.equal((await fac.verify(p, req())).isValid, true);
  const s = await fac.settle(p, req());
  assert.equal(s.success, true);
  assert.match(s.transaction, /^sim_[0-9a-f]+$/);
  assert.doesNotMatch(s.transaction, /^0x/);
  assert.equal(ledger.balanceOf(address), usdToAtomic(5) - 10000n);
  assert.equal(ledger.balanceOf(PAYEE), 10000n);
});

test("replayed authorization is rejected (nonce reuse)", async () => {
  const { fac, sign } = setup();
  const p = await sign(req());
  assert.equal((await fac.settle(p, req())).success, true);
  const again = await fac.settle(p, req());
  assert.equal(again.success, false);
  assert.equal(again.errorReason, "nonce_already_used");
});

test("signature for one payee cannot be redirected to another", async () => {
  const { fac, sign } = setup();
  const p = await sign(req());
  const r = await fac.verify(p, req("10000", "0xbad0000000000000000000000000000000000bad"));
  assert.equal(r.isValid, false);
  assert.equal(r.invalidReason, "recipient_mismatch");
});

test("tampered amount or forged signature is rejected", async () => {
  const { fac, sign } = setup();
  const p = await sign(req());
  assert.equal((await fac.verify(p, req("20000"))).invalidReason, "amount_mismatch");
  const auth = (p.payload as { authorization: Record<string, string> }).authorization;
  const forged = { ...p, payload: { ...p.payload, authorization: { ...auth, value: "20000" } } };
  assert.equal((await fac.verify(forged, req("20000"))).invalidReason, "invalid_signature");
});

test("insufficient simulated balance is rejected and nothing moves", async () => {
  const { fac, sign, ledger, address } = setup(0.005);
  const p = await sign(req("10000"));
  const s = await fac.settle(p, req("10000"));
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "insufficient_funds");
  assert.equal(ledger.receipts().length, 0);
  assert.equal(ledger.balanceOf(address), 5000n);
});

test("unregistered payer has no funds", async () => {
  const { sign } = setup();
  const other = new SimulatedFacilitator(SIM_NETWORK.caip2, SIM_NETWORK.chainId);
  const r = await other.verify(await sign(req()), req());
  assert.equal(r.invalidReason, "insufficient_funds");
});

test("ledger persists balances and receipts to disk", async () => {
  const { sign, fac, ledger } = setup();
  await fac.settle(await sign(req()), req());
  const path = (ledger as unknown as { path: string }).path;
  const reopened = new SimulatedUsdcLedger(path, SIM_NETWORK.usdc);
  assert.equal(reopened.receipts().length, 1);
  assert.equal(reopened.balanceOf(PAYEE), 10000n);
});
