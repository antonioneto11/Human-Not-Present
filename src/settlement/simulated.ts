/**
 * SIMULATED settlement. No chain, no real money.
 *
 * Verification is real: the EIP-3009 TransferWithAuthorization signature the agent
 * produced is checked with EIP-712 recovery, along with payee, amount, validity
 * window, nonce reuse and balance. Only the final step (moving USDC) is simulated,
 * by debiting a local file-backed ledger. Receipt IDs are prefixed "sim_" and are
 * never formatted as on-chain transaction hashes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, verifyTypedData, type Hex } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface SimReceipt {
  id: string; // "sim_…" — NOT an on-chain transaction hash
  ts: string;
  from: string;
  to: string;
  amountAtomic: string;
  nonce: string;
  network: string;
}

interface SimState {
  simulated: true;
  asset: string;
  balances: Record<string, string>; // lowercase address → atomic USDC
  usedNonces: string[];
  receipts: SimReceipt[];
}

/** A file-backed USDC ledger standing in for the token contract. */
export class SimulatedUsdcLedger {
  private state: SimState;

  constructor(
    private readonly path: string,
    asset: string,
    initialBalances: Record<string, bigint> = {},
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      this.state = JSON.parse(readFileSync(path, "utf8"));
    } else {
      this.state = { simulated: true, asset, balances: {}, usedNonces: [], receipts: [] };
      for (const [addr, bal] of Object.entries(initialBalances)) this.state.balances[addr.toLowerCase()] = bal.toString();
      this.save();
    }
  }

  balanceOf(address: string): bigint {
    return BigInt(this.state.balances[address.toLowerCase()] ?? "0");
  }

  isNonceUsed(from: string, nonce: string): boolean {
    return this.state.usedNonces.includes(`${from.toLowerCase()}:${nonce.toLowerCase()}`);
  }

  receipts(): SimReceipt[] {
    return [...this.state.receipts];
  }

  /** Atomic debit/credit. Throws on insufficient balance or nonce reuse. */
  transfer(from: string, to: string, amount: bigint, nonce: string, network: string): SimReceipt {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    if (this.isNonceUsed(f, nonce)) throw new Error("nonce_already_used");
    if (this.balanceOf(f) < amount) throw new Error("insufficient_funds");
    this.state.balances[f] = (this.balanceOf(f) - amount).toString();
    this.state.balances[t] = (this.balanceOf(t) + amount).toString();
    this.state.usedNonces.push(`${f}:${nonce.toLowerCase()}`);
    const receipt: SimReceipt = {
      id: `sim_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      ts: new Date().toISOString(),
      from: getAddress(from),
      to: getAddress(to),
      amountAtomic: amount.toString(),
      nonce,
      network,
    };
    this.state.receipts.push(receipt);
    this.save();
    return receipt;
  }

  private save() {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}

interface Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/**
 * Implements x402's FacilitatorClient interface — the same interface the real
 * HTTP facilitator implements — so merchants can't tell the difference.
 *
 * Payers are routed to a ledger by address, so concurrent experiment runs
 * (each with its own fresh wallet and ledger) never share state.
 */
export class SimulatedFacilitator implements FacilitatorClient {
  private readonly ledgers = new Map<string, SimulatedUsdcLedger>();

  constructor(private readonly network: string, private readonly chainId: number) {}

  /** Attach a payer's ledger. Unregistered payers have no funds. */
  registerPayer(address: string, ledger: SimulatedUsdcLedger) {
    this.ledgers.set(address.toLowerCase(), ledger);
  }

  unregisterPayer(address: string) {
    this.ledgers.delete(address.toLowerCase());
  }

  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: this.network as `${string}:${string}` }], extensions: [], signers: {} };
  }

  async verify(paymentPayload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.check(paymentPayload, req);
    return r.ok ? { isValid: true, payer: r.auth.from } : { isValid: false, invalidReason: r.reason, payer: r.payer };
  }

  async settle(paymentPayload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const r = await this.check(paymentPayload, req);
    const network = req.network;
    if (!r.ok) return { success: false, errorReason: r.reason, transaction: "", network, payer: r.payer };
    try {
      const receipt = r.ledger.transfer(r.auth.from, r.auth.to, BigInt(r.auth.value), r.auth.nonce, network);
      return { success: true, transaction: receipt.id, network, payer: r.auth.from, amount: receipt.amountAtomic };
    } catch (err) {
      return { success: false, errorReason: (err as Error).message, transaction: "", network, payer: r.auth.from };
    }
  }

  private async check(p: PaymentPayload, req: PaymentRequirements) {
    const auth = (p.payload as { authorization?: Authorization }).authorization;
    const signature = (p.payload as { signature?: Hex }).signature;
    const fail = (reason: string) => ({ ok: false as const, reason, payer: auth?.from });
    if (!auth || !signature) return fail("invalid_payload");
    if (req.scheme !== "exact" || req.network !== this.network) return fail("unsupported_scheme_or_network");
    if (auth.to.toLowerCase() !== req.payTo.toLowerCase()) return fail("recipient_mismatch");
    if (BigInt(auth.value) !== BigInt(req.amount)) return fail("amount_mismatch");
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(auth.validAfter) > now || BigInt(auth.validBefore) <= now) return fail("authorization_expired_or_not_yet_valid");

    const extra = req.extra as { name?: string; version?: string };
    const validSig = await verifyTypedData({
      address: auth.from,
      domain: { name: extra.name, version: extra.version, chainId: this.chainId, verifyingContract: getAddress(req.asset) },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(auth.from),
        to: getAddress(auth.to),
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    }).catch(() => false);
    if (!validSig) return fail("invalid_signature");

    const ledger = this.ledgers.get(auth.from.toLowerCase());
    if (!ledger) return fail("insufficient_funds");
    if (ledger.isNonceUsed(auth.from, auth.nonce)) return fail("nonce_already_used");
    if (ledger.balanceOf(auth.from) < BigInt(auth.value)) return fail("insufficient_funds");
    return { ok: true as const, auth, ledger };
  }
}
