import { randomUUID } from "node:crypto";
import { runAgent } from "./agent";
import { terminalApprover } from "./approval";
import { LEDGER_PATH, loadAgentWalletKey, loadNetwork, loadPolicyConfig } from "./config";
import { Ledger } from "./ledger";
import { PaymentService } from "./payments";

const task =
  process.argv.slice(2).join(" ") ||
  "The shop at http://localhost:4021 sells data. Get me the current weather in Lisbon and today's USD→EUR rate, then summarize both in two sentences.";

const network = loadNetwork();
const policy = loadPolicyConfig();
const ledger = new Ledger(LEDGER_PATH);
const runId = randomUUID();
const payments = new PaymentService(loadAgentWalletKey(), network, policy, ledger, terminalApprover, runId);

console.log(`🤖 agent-pay  run=${runId.slice(0, 8)}  wallet=${payments.address}  network=${network.name}`);
console.log(`📋 Task: ${task}\n`);

const answer = await runAgent({ task, payments, ledger, policy, networkName: network.name });

console.log("\n──────────────── Result ────────────────\n");
console.log(answer);
console.log(`\n🧾 Audit log: ${LEDGER_PATH}`);
