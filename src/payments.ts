import { createHash } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { Approver } from "./approval";
import { checkDelivery, PRODUCT_SPECS, type DeliveryResult, type DeliverySpecs } from "./delivery";
import type { Ledger, LedgerEntry } from "./ledger";
import { atomicToUsd } from "./money";
import { evaluatePolicy, type PolicyConfig } from "./policy";

export interface NetworkInfo {
  caip2: string;
  usdc: string;
  /** Block-explorer tx URL prefix. Only used for real (non-simulated) settlement. */
  explorerTx?: string;
  /** True when settlement is simulated: receipts are local IDs, never explorer links. */
  simulated?: boolean;
}

export interface Quote {
  url: string;
  merchant: string;
  free: boolean;
  amountUsd?: string;
  requirement?: PaymentRequirements;
  paymentRequired?: PaymentRequired;
  description?: string;
}

export type PurchaseResult =
  | { status: "settled"; data: unknown; receipt: LedgerEntry; replayed: boolean; delivery?: DeliveryResult }
  | { status: "free"; data: unknown }
  | { status: "denied" | "declined" | "failed"; message: string; receipt?: LedgerEntry };

/**
 * Wraps an x402 client so that every payment goes through:
 *   quote → idempotency check → policy → (human approval) → sign → send → settle → ledger
 */
export class PaymentService {
  private readonly http: x402HTTPClient;
  readonly address: Hex;

  constructor(
    privateKey: Hex,
    private readonly network: NetworkInfo,
    private readonly policy: PolicyConfig,
    private readonly ledger: Ledger,
    private readonly approve: Approver,
    private readonly runId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly deliverySpecs: DeliverySpecs = PRODUCT_SPECS,
  ) {
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    // Only register the one network we're configured for: the client physically
    // cannot sign for any other chain, regardless of what a merchant asks for.
    this.http = new x402HTTPClient(new x402Client().register(network.caip2 as `${string}:${string}`, new ExactEvmScheme(account)));
  }

  /** Probe a URL without paying. Returns the price if it's behind an x402 paywall. */
  async quote(url: string): Promise<Quote> {
    const merchant = new URL(url).host;
    const res = await this.fetchImpl(url);
    if (res.status !== 402) {
      return { url, merchant, free: true };
    }
    const body = await res.json().catch(() => undefined);
    const paymentRequired = this.http.getPaymentRequiredResponse((h) => res.headers.get(h), body);
    // Prefer an option on our network; fall back to the first so policy can explain the mismatch.
    const requirement =
      paymentRequired.accepts.find((r) => r.network === this.network.caip2 && r.scheme === "exact") ??
      paymentRequired.accepts[0];
    if (!requirement) throw new Error(`${url} returned 402 with no payment options`);
    return {
      url,
      merchant,
      free: false,
      amountUsd: atomicToUsd(requirement.amount),
      requirement,
      paymentRequired,
      description: paymentRequired.resource?.description,
    };
  }

  /**
   * One purchase per (run, URL). If the agent retries the same purchase in the same run
   * — e.g. after a timeout — we return the original receipt instead of paying twice.
   */
  idempotencyKey(url: string): string {
    return createHash("sha256").update(`${this.runId}|GET|${url}`).digest("hex").slice(0, 32);
  }

  async purchase(url: string, reason: string): Promise<PurchaseResult> {
    const key = this.idempotencyKey(url);
    const prior = this.ledger.find(key);
    if (prior?.status === "settled") {
      return { status: "settled", data: null, receipt: prior, replayed: true };
    }
    if (prior?.status === "authorized") {
      return {
        status: "failed",
        message: "A payment for this resource is already in flight with an unknown outcome; refusing to pay again. Check the ledger.",
        receipt: prior,
      };
    }

    const quote = await this.quote(url);
    if (quote.free || !quote.requirement || !quote.paymentRequired) {
      const res = await this.fetchImpl(url);
      return { status: "free", data: await readBody(res) };
    }
    const req = quote.requirement;
    const base = {
      ...(this.network.simulated ? { simulated: true } : {}),
      idempotencyKey: key,
      runId: this.runId,
      url,
      merchant: quote.merchant,
      reason,
      amountAtomic: req.amount,
      network: req.network,
      payTo: req.payTo,
    };

    // 1. Policy (deterministic, not up to the model)
    const decision = evaluatePolicy(
      { merchant: quote.merchant, network: req.network, asset: req.asset, amountAtomic: BigInt(req.amount), payTo: req.payTo },
      this.policy,
      { expectedNetwork: this.network.caip2, expectedAsset: this.network.usdc, spentTodayAtomic: this.ledger.spentTodayAtomic() },
    );
    if (decision.outcome === "deny") {
      const receipt = this.ledger.append({ ...base, status: "denied", policy: `${decision.rule}: ${decision.reason}` });
      return { status: "denied", message: `Policy denied: ${decision.reason}`, receipt };
    }

    // 2. Human approval above the threshold
    if (decision.outcome === "needs_approval") {
      const ok = await this.approve({ url, merchant: quote.merchant, amountUsd: quote.amountUsd!, reason, policyNote: decision.reason });
      if (!ok) {
        const receipt = this.ledger.append({ ...base, status: "declined", policy: decision.reason });
        return { status: "declined", message: "The human approver declined this payment.", receipt };
      }
    }

    // 3. Sign exactly the requirement that policy evaluated — nothing else.
    const payload = await this.http.createPaymentPayload({ ...quote.paymentRequired, accepts: [req] });
    this.ledger.append({ ...base, status: "authorized", policy: decision.reason });

    // 4. Send and settle
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: this.http.encodePaymentSignatureHeader(payload) });
    } catch (err) {
      // Network error after signing: outcome unknown. Leave it "authorized" so it
      // keeps counting against the budget and blocks a duplicate payment.
      return { status: "failed", message: `Network error after signing; outcome unknown: ${String(err)}` };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const receipt = this.ledger.append({ ...base, status: "failed", error: `HTTP ${res.status} ${detail.slice(0, 300)}` });
      return { status: "failed", message: `Merchant rejected payment (HTTP ${res.status}).`, receipt };
    }

    const settle = safe(() => this.http.getPaymentSettleResponse((h) => res.headers.get(h)));
    const data = await readBody(res);
    const tx = settle?.transaction;
    // Code, not the model, decides whether what we paid for is usable.
    const delivery = checkDelivery(url, data, this.deliverySpecs);
    const receipt = this.ledger.append({
      ...base,
      status: "settled",
      transaction: tx,
      // Never link a simulated receipt to a block explorer.
      explorerUrl: tx && this.network.explorerTx && !this.network.simulated ? `${this.network.explorerTx}${tx}` : undefined,
      amountAtomic: settle?.amount ?? req.amount,
      delivery: delivery.status,
      deliveryNote: delivery.status === "passed" ? undefined : delivery.reason,
    });
    return { status: "settled", data, receipt, replayed: false, delivery };
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
