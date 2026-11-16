/**
 * A tiny merchant that sells data over x402. Prices are chosen to exercise every
 * branch of the agent's policy: auto-approved, needs human approval, and over the cap.
 */
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { loadMerchantConfig, loadNetwork } from "../config";

const net = loadNetwork();
const cfg = loadMerchantConfig();
type Caip2 = `${string}:${string}`;

const PRODUCTS = [
  { path: "/api/weather", price: "$0.001", description: "Current weather for a city (?city=Lisbon)" },
  { path: "/api/fx-rates", price: "$0.01", description: "Live FX rates for major currencies vs USD" },
  { path: "/api/market-brief", price: "$0.05", description: "A short daily brief on crypto payments news" },
  { path: "/api/deep-report", price: "$0.50", description: "In-depth report on agentic commerce protocols" },
  { path: "/api/enterprise-dataset", price: "$25.00", description: "Bulk merchant transaction dataset" },
] as const;

const routes = Object.fromEntries(
  PRODUCTS.map((p) => [
    `GET ${p.path}`,
    {
      accepts: { scheme: "exact", price: p.price, network: net.caip2 as Caip2, payTo: cfg.payTo, maxTimeoutSeconds: 120 },
      description: p.description,
      mimeType: "application/json",
    },
  ]),
);

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl })).register(
  net.caip2 as Caip2,
  new ExactEvmScheme(),
);

const app = express();

// Free: the catalog. Lets the agent discover what's for sale before spending anything.
app.get("/catalog", (_req, res) => {
  res.json({
    merchant: "Demo Data Shop",
    network: net.name,
    currency: "USDC",
    products: PRODUCTS.map((p) => ({ url: `http://localhost:${cfg.port}${p.path}`, price: p.price, description: p.description })),
  });
});

app.use(paymentMiddleware(routes, resourceServer));

app.get("/api/weather", (req, res) => {
  const city = String(req.query.city ?? "Lisbon");
  const temp = 14 + Math.round(Math.random() * 12);
  res.json({ city, temperatureC: temp, conditions: temp > 20 ? "sunny" : "partly cloudy", asOf: new Date().toISOString() });
});
app.get("/api/fx-rates", (_req, res) => {
  res.json({ base: "USD", rates: { EUR: 0.92, GBP: 0.79, BRL: 5.41, JPY: 151.2 }, asOf: new Date().toISOString() });
});
app.get("/api/market-brief", (_req, res) => {
  res.json({
    headline: "Agent-initiated payments move from demos to production pilots",
    bullets: [
      "HTTP 402-based protocols let APIs charge per request with no accounts or API keys.",
      "Stablecoin settlement makes sub-cent payments economical.",
      "Card networks are shipping agent-specific credentials and spend controls.",
    ],
  });
});
app.get("/api/deep-report", (_req, res) => {
  res.json({ title: "Agentic Commerce Protocols: a field guide", sections: ["x402", "ACP", "AP2", "Network agent tokens"], pages: 42 });
});
app.get("/api/enterprise-dataset", (_req, res) => {
  res.json({ rows: 1_000_000 });
});

app.listen(cfg.port, () => {
  console.log(`🏪 Merchant listening on http://localhost:${cfg.port}  (network: ${net.name}, payTo: ${cfg.payTo})`);
  console.log(`   Catalog: http://localhost:${cfg.port}/catalog`);
});
