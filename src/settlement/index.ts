/**
 * The settlement seam.
 *
 * Merchants verify and settle payments through x402's `FacilitatorClient` interface
 * (verify / settle / getSupported). Everything upstream — the agent, the policy
 * layer, the signed x402 payment flow — is identical whichever implementation sits here:
 *
 *   simulated → SimulatedFacilitator (real signature verification, local USDC ledger)
 *   testnet   → HTTPFacilitatorClient pointed at a real facilitator (Base Sepolia)
 *
 * Swapping to testnet is a config change here, not a change to the agent or policy.
 */
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { SimulatedFacilitator } from "./simulated";

export type { FacilitatorClient };
export { SimulatedFacilitator, SimulatedUsdcLedger, type SimReceipt } from "./simulated";

export type SettlementMode = "simulated" | "testnet";

export const SIM_NETWORK = {
  caip2: "eip155:84532", // signatures use Base Sepolia's chain id + USDC domain; nothing is sent to it
  chainId: 84532,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  simulated: true as const, // → no block-explorer links are ever generated
};

export function createFacilitator(mode: SettlementMode, opts: { facilitatorUrl?: string } = {}): FacilitatorClient {
  if (mode === "simulated") return new SimulatedFacilitator(SIM_NETWORK.caip2, SIM_NETWORK.chainId);
  return new HTTPFacilitatorClient({ url: opts.facilitatorUrl ?? "https://x402.org/facilitator" });
}
