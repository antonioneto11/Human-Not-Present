/**
 * Local playground UI.
 *
 *   npm run ui   →  http://localhost:4000
 *
 * Starts the four simulated merchants, a simulated wallet ($5.00) and a web page where
 * you can set the policy and mandate, run the agent on a task, approve or decline
 * payments, watch the audit ledger, and run the scripted attack suite.
 * Settlement is SIMULATED: no chain, no real money. Agent runs call the Claude API.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import express, { type Response } from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import "dotenv/config";
import { MODEL, runAgent } from "../agent";
import type { Approver, ApprovalRequest } from "../approval";
import { TASK } from "../experiment/scenario";
import { Ledger } from "../ledger";
import { MERCHANTS, startAllMerchants } from "../merchant/merchants";
import { atomicToUsd, usdToAtomic } from "../money";
import { PaymentService } from "../payments";
import type { PolicyConfig, TaskMandate } from "../policy";
import { SIM_NETWORK, SimulatedFacilitator, SimulatedUsdcLedger } from "../settlement";
import { ATTACKS, runSuite, SETUPS } from "../attacks/suite";

const PORT = Number(process.env.UI_PORT ?? 4000);
const DATA = join("data", "ui");
const STARTING_BALANCE = usdToAtomic(5);

// ---- Simulated world: merchants + one wallet, reset on demand ----
const facilitator = new SimulatedFacilitator(SIM_NETWORK.caip2, SIM_NETWORK.chainId);
const servers = await startAllMerchants(facilitator, SIM_NETWORK.caip2);

let key = generatePrivateKey();
let address = privateKeyToAccount(key).address;
let chain: SimulatedUsdcLedger;
let ledger: Ledger;
function resetWorld() {
  facilitator.unregisterPayer(address);
  rmSync(DATA, { recursive: true, force: true });
  key = generatePrivateKey();
  address = privateKeyToAccount(key).address;
  chain = new SimulatedUsdcLedger(join(DATA, "sim-wallet.json"), SIM_NETWORK.usdc, { [address]: STARTING_BALANCE });
  facilitator.registerPayer(address, chain);
  ledger = new Ledger(join(DATA, "ledger.jsonl"));
}
resetWorld();

// ---- Live events to the page (Server-Sent Events) ----
const clients = new Set<Response>();
function emit(type: string, data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

// ---- Approvals: the agent waits until someone clicks in the page ----
const pending = new Map<string, (ok: boolean) => void>();
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const pageApprover: Approver = (req: ApprovalRequest) =>
  new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      emit("approval_closed", { id, ok: false, why: "timed out, declined" });
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, (ok) => {
      clearTimeout(timer);
      pending.delete(id);
      emit("approval_closed", { id, ok });
      resolve(ok);
    });
    emit("approval", { id, ...req });
  });

// ---- What the page needs to draw its forms ----
const priceUsd = (p: string) => Number(p.replace("$", ""));
function catalog() {
  return MERCHANTS.map((m) => ({
    role: m.role,
    name: m.name,
    host: `localhost:${m.port}`,
    payTo: m.payTo,
    hasInjection: Boolean(m.catalogNotice),
    products: m.products.map((p) => ({
      resource: `localhost:${m.port}${p.path}`,
      path: p.path,
      priceUsd: priceUsd(p.price),
      description: p.description,
      payTo: p.payTo ?? m.payTo,
    })),
  }));
}

interface RunSettings {
  task: string;
  maxPerTransactionUsd: number;
  dailyBudgetUsd: number;
  approvalThresholdUsd: number;
  allowlist: string[]; // hosts
  pinPayees: boolean;
  approvals: "ask" | "always_no" | "always_yes";
  mandate: TaskMandate | null;
}

function buildPolicy(s: RunSettings): PolicyConfig {
  const hosts = s.allowlist.map((h) => h.toLowerCase());
  const payees = Object.fromEntries(catalog().filter((m) => hosts.includes(m.host)).map((m) => [m.host, m.payTo]));
  return {
    maxPerTransactionUsd: s.maxPerTransactionUsd,
    dailyBudgetUsd: s.dailyBudgetUsd,
    approvalThresholdUsd: s.approvalThresholdUsd,
    allowedMerchants: hosts,
    ...(s.pinPayees ? { merchantPayees: payees } : {}),
    ...(s.mandate ? { mandate: s.mandate } : {}),
  };
}

const state = () => ({
  address,
  balance: atomicToUsd(chain.balanceOf(address)),
  spentToday: atomicToUsd(ledger.spentTodayAtomic()),
  ledger: ledger.all(),
  running: currentRun !== null,
  model: MODEL,
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
});

// ---- HTTP ----
const app = express();
app.use(express.json());

const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");
app.get("/", (_req, res) => res.type("html").send(page));
app.get("/api/catalog", (_req, res) => res.json({ merchants: catalog(), defaultTask: TASK }));
app.get("/api/state", (_req, res) => res.json(state()));

app.get("/api/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

let currentRun: string | null = null;
app.post("/api/run", async (req, res) => {
  if (currentRun) return res.status(409).json({ error: "a run is already in progress" });
  const s = req.body as RunSettings;
  if (!s.task?.trim()) return res.status(400).json({ error: "task is empty" });
  const policy = buildPolicy(s);
  const runId = randomUUID();
  currentRun = runId;
  res.json({ runId });

  const approver: Approver = s.approvals === "ask" ? pageApprover : async () => s.approvals === "always_yes";
  const payments = new PaymentService(key, SIM_NETWORK, policy, ledger, approver, runId);
  emit("run_start", { runId, task: s.task, policy });
  const before = ledger.all().length;
  const ledgerTimer = setInterval(() => emit("state", state()), 700);
  try {
    const r = await runAgent({
      task: s.task,
      payments,
      ledger,
      policy,
      networkName: "SIMULATED (no chain connection)",
      balance: () => `${atomicToUsd(chain.balanceOf(address))} USDC (simulated)`,
      onEvent: (line) => emit("log", { line }),
      onTrace: (e) => emit("trace", e),
    });
    emit("run_end", { runId, answer: r.answer, usage: r.usage, newEntries: ledger.all().length - before });
  } catch (err) {
    emit("run_end", { runId, error: String(err) });
  } finally {
    clearInterval(ledgerTimer);
    currentRun = null;
    for (const resolve of pending.values()) resolve(false);
    emit("state", state());
  }
});

app.post("/api/approve", (req, res) => {
  const { id, ok } = req.body as { id: string; ok: boolean };
  const resolve = pending.get(id);
  if (!resolve) return res.status(404).json({ error: "no such pending approval" });
  resolve(Boolean(ok));
  res.json({ ok: true });
});

app.post("/api/reset", (_req, res) => {
  if (currentRun) return res.status(409).json({ error: "wait for the run to finish" });
  resetWorld();
  emit("state", state());
  res.json(state());
});

app.post("/api/attacks", async (_req, res) => {
  const results = await runSuite();
  res.json({ setups: SETUPS, attacks: ATTACKS.map(({ id, name, description }) => ({ id, name, description })), results });
});

const httpServer = app.listen(PORT, () => {
  console.log(`\n  Human Not Present playground → http://localhost:${PORT}`);
  console.log(`  Merchants on ports ${MERCHANTS.map((m) => m.port).join(", ")} · settlement SIMULATED · model ${MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log("  ⚠️  ANTHROPIC_API_KEY is not set: agent runs will fail; the attack suite still works.");
});

process.on("SIGINT", () => {
  httpServer.close();
  servers.forEach((s) => s.close());
  process.exit(0);
});
