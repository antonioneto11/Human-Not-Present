/**
 * Single interactive run.
 *
 *   SETTLEMENT=simulated (default): starts the four simulated merchants in-process and
 *     pays from a local simulated wallet (data/sim-wallet.json, $5.00 to start).
 *   SETTLEMENT=testnet: pays real testnet USDC from AGENT_PRIVATE_KEY to merchants
 *     started separately with `npm run merchant`.
 */
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { runAgent } from "./agent";
import { terminalApprover } from "./approval";
import { LEDGER_PATH, loadAgentWalletKey, loadNetwork, loadPolicyConfig } from "./config";
import { Ledger } from "./ledger";
import { experimentAllowlist, startAllMerchants } from "./merchant/merchants";
import { atomicToUsd, usdToAtomic } from "./money";
import { PaymentService } from "./payments";
import { SIM_NETWORK, SimulatedFacilitator, SimulatedUsdcLedger } from "./settlement";
import { TASK } from "./experiment/scenario";

const task = process.argv.slice(2).join(" ") || TASK;
const mode = (process.env.SETTLEMENT ?? "simulated") as "simulated" | "testnet";
const ledger = new Ledger(LEDGER_PATH);
const runId = randomUUID();

let payments: PaymentService;
let networkName: string;
let balance: (() => string) | undefined;
let policy = loadPolicyConfig();
const closers: (() => void)[] = [];

if (mode === "simulated") {
  // Simulated wallet: key is generated locally and only ever signs for the simulator.
  const key = (process.env.AGENT_PRIVATE_KEY as Hex | undefined) || generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const chain = new SimulatedUsdcLedger("data/sim-wallet.json", SIM_NETWORK.usdc, { [address]: usdToAtomic(5) });
  const facilitator = new SimulatedFacilitator(SIM_NETWORK.caip2, SIM_NETWORK.chainId);
  facilitator.registerPayer(address, chain);
  const servers = await startAllMerchants(facilitator, SIM_NETWORK.caip2);
  closers.push(() => servers.forEach((s) => s.close()));
  policy = { ...policy, ...experimentAllowlist() };
  payments = new PaymentService(key, SIM_NETWORK, policy, ledger, terminalApprover, runId);
  networkName = "SIMULATED (no chain connection)";
  balance = () => `${atomicToUsd(chain.balanceOf(address))} USDC (simulated)`;
} else {
  const network = loadNetwork();
  payments = new PaymentService(loadAgentWalletKey(), network, policy, ledger, terminalApprover, runId);
  networkName = network.name;
}

console.log(`🤖 Human Not Present  run=${runId.slice(0, 8)}  wallet=${payments.address}  settlement=${mode.toUpperCase()}`);
console.log(`📋 Task: ${task}\n`);

const { answer } = await runAgent({ task, payments, ledger, policy, networkName, balance });
closers.forEach((c) => c());

console.log("\n──────────────── Result ────────────────\n");
console.log(answer);
console.log(`\n🧾 Audit log: ${LEDGER_PATH}${mode === "simulated" ? "  ·  Simulated wallet: data/sim-wallet.json" : ""}`);
