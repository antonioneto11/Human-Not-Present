/**
 * End-to-end tests of the payment pipeline against an in-memory fake merchant.
 * Signatures are real (EIP-712 via viem); only the HTTP + chain are faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey } from "viem/accounts";
import { Ledger } from "../src/ledger";
import { PaymentService } from "../src/payments";
import type { Approver } from "../src/approval";

const NET = { caip2: "eip155:84532", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", explorerTx: "https://sepolia.basescan.org/tx/" };
const POLICY = { maxPerTransactionUsd: 1, dailyBudgetUsd: 2, approvalThresholdUsd: 0.1, allowedMerchants: ["shop.test"] };
const PRICES: Record<string, string> = { "/cheap": "10000", "/pricey": "500000", "/huge": "25000000" }; // atomic USDC

function fakeMerchant() {
  const calls = { paid: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const price = PRICES[url.pathname];
    const headers = new Headers(init?.headers);
    const sig = headers.get("PAYMENT-SIGNATURE");
    if (!sig) {
      const pr = {
        x402Version: 2,
        resource: { url: url.href, description: `item ${url.pathname}`, mimeType: "application/json" },
        accepts: [
          {
            scheme: "exact",
            network: NET.caip2,
            asset: NET.usdc,
            amount: price,
            payTo: "0x000000000000000000000000000000000000dEaD",
            maxTimeoutSeconds: 60,
            extra: { name: "USDC", version: "2" },
          },
        ],
      };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as never) } });
    }
    const payload = decodePaymentSignatureHeader(sig);
    assert.equal(payload.accepted.amount, price, "client signed the amount it was quoted");
    calls.paid++;
    const settle = { success: true, transaction: `0xtx${calls.paid}`, network: NET.caip2 };
    return new Response(JSON.stringify({ item: url.pathname }), {
      status: 200,
      headers: { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle as never) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function setup(approve: Approver = async () => true) {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "agentpay-")), "ledger.jsonl"));
  const m = fakeMerchant();
  const svc = new PaymentService(generatePrivateKey(), NET, POLICY, ledger, approve, "run-1", m.fetchImpl);
  return { ledger, svc, ...m };
}

test("quote reports price without paying", async () => {
  const { svc, calls } = setup();
  const q = await svc.quote("http://shop.test/cheap");
  assert.equal(q.free, false);
  assert.equal(q.amountUsd, "$0.01");
  assert.equal(calls.paid, 0);
});

test("small purchase settles and is written to the ledger with tx link", async () => {
  const { svc, ledger, calls } = setup();
  const r = await svc.purchase("http://shop.test/cheap", "need the cheap item for the test");
  assert.equal(r.status, "settled");
  assert.equal(calls.paid, 1);
  const statuses = ledger.all().map((e) => e.status);
  assert.deepEqual(statuses, ["authorized", "settled"]);
  assert.equal(ledger.all()[1].explorerUrl, "https://sepolia.basescan.org/tx/0xtx1");
  assert.equal(ledger.spentTodayAtomic(), 10000n);
});

test("retrying the same purchase in a run does not pay twice", async () => {
  const { svc, calls } = setup();
  await svc.purchase("http://shop.test/cheap", "first attempt at buying");
  const again = await svc.purchase("http://shop.test/cheap", "agent retried the same thing");
  assert.equal(again.status, "settled");
  assert.equal(again.status === "settled" && again.replayed, true);
  assert.equal(calls.paid, 1);
});

test("above threshold asks the human; a decline means no payment", async () => {
  let asked = 0;
  const { svc, calls, ledger } = setup(async () => (asked++, false));
  const r = await svc.purchase("http://shop.test/pricey", "want the pricey report");
  assert.equal(asked, 1);
  assert.equal(r.status, "declined");
  assert.equal(calls.paid, 0);
  assert.equal(ledger.all().at(-1)?.status, "declined");
});

test("over the cap is denied before the human is even asked", async () => {
  let asked = 0;
  const { svc, calls } = setup(async () => (asked++, true));
  const r = await svc.purchase("http://shop.test/huge", "want the whole dataset");
  assert.equal(r.status, "denied");
  assert.equal(asked, 0);
  assert.equal(calls.paid, 0);
});

test("non-allowlisted merchant is denied", async () => {
  const { svc, calls } = setup();
  const r = await svc.purchase("http://evil.test/cheap", "looks cheap enough to buy");
  assert.equal(r.status, "denied");
  assert.equal(calls.paid, 0);
});
