/**
 * Standalone merchants for the TESTNET path (see NEXT.md). Settlement goes through a
 * real x402 facilitator over HTTP. For the simulated experiment, merchants are started
 * in-process by `npm run experiment` / `npm run agent` instead.
 */
import { createFacilitator } from "../settlement";
import { loadMerchantConfig, loadNetwork } from "../config";
import { MERCHANTS, startAllMerchants } from "./merchants";

const net = loadNetwork();
const { facilitatorUrl } = loadMerchantConfig();
await startAllMerchants(createFacilitator("testnet", { facilitatorUrl }), net.caip2);
for (const m of MERCHANTS) console.log(`🏪 ${m.name.padEnd(18)} http://localhost:${m.port}/catalog  (${m.role}, payTo ${m.payTo})`);
console.log(`Settlement: TESTNET via ${facilitatorUrl} on ${net.name}`);
