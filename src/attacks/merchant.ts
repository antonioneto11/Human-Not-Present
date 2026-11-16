/**
 * A programmable hostile merchant for the attack suite.
 *
 * Unlike the Express merchants, this one hand-writes its x402 responses, so it can
 * misbehave at the protocol level: switch prices between requests, ask for another
 * network or token, swap the payee, redirect to another host, or try to settle for a
 * different amount than the buyer signed. Settlement still goes through the real
 * SimulatedFacilitator, which verifies the buyer's EIP-712 signature, so the sim
 * ledger is the ground truth for what money actually moved.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { FacilitatorClient } from "../settlement";

export interface RouteBehavior {
  /** Atomic USDC. A function gets the 1-based count of unpaid requests to this path (for bait-and-switch). */
  price: string | ((unpaidRequestNo: number) => string);
  payTo?: string; // defaults to the merchant's registered payee
  network?: string; // defaults to the merchant's network
  asset?: string; // defaults to the merchant's asset
  /** Merchant tries to settle a different amount than the one in the 402 (and the buyer signed). */
  settleAmount?: string;
  /** Respond 302 to this absolute URL instead of selling anything. */
  redirectTo?: string;
  body?: unknown;
}

export interface AttackMerchant {
  server: Server;
  host: string; // "localhost:<port>"
  baseUrl: string;
  close(): Promise<void>;
}

export async function startAttackMerchant(opts: {
  routes: Record<string, RouteBehavior>;
  payTo: string;
  network: string;
  asset: string;
  facilitator: FacilitatorClient;
}): Promise<AttackMerchant> {
  const unpaidCount = new Map<string, number>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = opts.routes[url.pathname];
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      if (route.redirectTo) {
        res.writeHead(302, { location: route.redirectTo }).end();
        return;
      }
      const sigHeader = req.headers["payment-signature"];
      if (!sigHeader) {
        const n = (unpaidCount.get(url.pathname) ?? 0) + 1;
        unpaidCount.set(url.pathname, n);
        const requirement: PaymentRequirements = {
          scheme: "exact",
          network: (route.network ?? opts.network) as `${string}:${string}`,
          asset: route.asset ?? opts.asset,
          amount: typeof route.price === "function" ? route.price(n) : route.price,
          payTo: route.payTo ?? opts.payTo,
          maxTimeoutSeconds: 120,
          extra: { name: "USDC", version: "2" },
        };
        const pr = {
          x402Version: 2,
          resource: { url: `http://${req.headers.host}${url.pathname}`, description: `attack product ${url.pathname}`, mimeType: "application/json" },
          accepts: [requirement],
        };
        res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as never) }).end("{}");
        return;
      }

      // Paid request: settle what the buyer signed, unless this route tries to settle something else.
      const payload = decodePaymentSignatureHeader(String(sigHeader));
      const toSettle = route.settleAmount ? { ...payload.accepted, amount: route.settleAmount } : payload.accepted;
      const settle = await opts.facilitator.settle(payload, toSettle);
      if (!settle.success) {
        res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: settle.errorReason }));
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) })
        .end(JSON.stringify(route.body ?? { ok: true, path: url.pathname }));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });

  // All interfaces, so both "localhost" and "127.0.0.1" reach it (the lookalike-host attack needs both).
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    host: `localhost:${port}`,
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
