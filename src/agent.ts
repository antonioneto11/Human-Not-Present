import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import type { Ledger } from "./ledger";
import { atomicToUsd, usdToAtomic } from "./money";
import type { PaymentService } from "./payments";
import type { PolicyConfig } from "./policy";

export const MODEL = "claude-opus-5-5";

const SYSTEM = `You are a purchasing agent with a USDC wallet. You complete the user's task by buying data from paid HTTP APIs that use the x402 protocol.

How to work:
- Discover what is for sale with list_catalog before buying anything.
- Buy only what the task actually needs. Prefer the cheapest resource that answers the question. Do not buy the same thing twice.
- Before a purchase, check the price with get_quote. Give every purchase a specific, honest reason; it is shown to a human approver and written to the audit log.
- A spend policy outside your control enforces a per-transaction cap, a daily budget, a merchant allowlist and human approval above a threshold. If a purchase is denied or declined, do not look for a way around it: tell the user what you could not buy and why, and finish with what you have.
- When you are done, answer the task, then list each payment you made with its amount and receipt reference.`;

export interface TraceEvent {
  ts: string;
  tool: string;
  input: unknown;
  output: unknown;
}

export interface AgentUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export async function runAgent(opts: {
  task: string;
  payments: PaymentService;
  ledger: Ledger;
  policy: PolicyConfig;
  networkName: string;
  balance?: () => string;
  onEvent?: (line: string) => void;
  onTrace?: (e: TraceEvent) => void;
  /** What the model says between tool calls, in its own words. */
  onText?: (text: string) => void;
}): Promise<{ answer: string; stopReason: string | null; usage: AgentUsage }> {
  const log = opts.onEvent ?? ((l: string) => console.log(l));
  const trace = (tool: string, input: unknown, output: string) => {
    let parsed: unknown = output;
    try {
      parsed = JSON.parse(output);
    } catch {}
    opts.onTrace?.({ ts: new Date().toISOString(), tool, input, output: parsed });
    return output;
  };
  const client = new Anthropic();

  const listCatalog = betaZodTool({
    name: "list_catalog",
    description: "Fetch a merchant's free product catalog (no payment). Pass the merchant base URL, e.g. http://localhost:4021.",
    inputSchema: z.object({ base_url: z.string().url() }),
    run: async (input) => {
      log(`  🔎 list_catalog ${input.base_url}`);
      try {
        const res = await fetch(new URL("/catalog", input.base_url));
        return trace("list_catalog", input, await res.text());
      } catch (err) {
        return trace("list_catalog", input, JSON.stringify({ error: `could not reach merchant: ${String(err)}` }));
      }
    },
  });

  const walletStatus = betaZodTool({
    name: "wallet_status",
    description: "Show the agent wallet address, balance, network, spend limits and how much budget is left today.",
    inputSchema: z.object({}),
    run: async (input) => {
      const spent = opts.ledger.spentTodayAtomic();
      const budget = usdToAtomic(opts.policy.dailyBudgetUsd);
      return trace(
        "wallet_status",
        input,
        JSON.stringify({
          address: opts.payments.address,
          network: opts.networkName,
          balance: opts.balance?.(),
          maxPerTransaction: `$${opts.policy.maxPerTransactionUsd}`,
          autoApproveUpTo: `$${opts.policy.approvalThresholdUsd}`,
          dailyBudget: `$${opts.policy.dailyBudgetUsd}`,
          spentToday: atomicToUsd(spent),
          remainingToday: atomicToUsd(budget > spent ? budget - spent : 0n),
          allowedMerchants: opts.policy.allowedMerchants,
          ...(opts.policy.mandate ? { taskMandate: opts.policy.mandate } : {}),
        }),
      );
    },
  });

  const getQuote = betaZodTool({
    name: "get_quote",
    description: "Check the price of a resource without paying. Returns whether it is free or what it costs.",
    inputSchema: z.object({ url: z.string().url() }),
    run: async (input) => {
      log(`  🏷️  get_quote ${input.url}`);
      try {
        const q = await opts.payments.quote(input.url);
        return trace(
          "get_quote",
          input,
          JSON.stringify(
            q.free
              ? { url: input.url, free: true }
              : { url: input.url, free: false, price: q.amountUsd, currency: "USDC", network: q.requirement?.network, description: q.description },
          ),
        );
      } catch (err) {
        return trace("get_quote", input, JSON.stringify({ error: String(err) }));
      }
    },
  });

  const purchase = betaZodTool({
    name: "purchase",
    description:
      "Pay for and fetch a resource. Payment goes through the spend policy and may require human approval. Returns the data, a payment receipt, and a delivery check on the data — or the reason the payment did not happen.",
    inputSchema: z.object({
      url: z.string().url(),
      reason: z.string().min(10).describe("Why this purchase is needed for the user's task. Shown to the human approver."),
    }),
    run: async (input) => {
      log(`  💸 purchase ${input.url}\n     reason: ${input.reason}`);
      let out: object;
      try {
        const r = await opts.payments.purchase(input.url, input.reason);
        switch (r.status) {
          case "settled": {
            const sim = r.receipt.simulated ? " [SIMULATED]" : "";
            const d = r.delivery ?? (r.receipt.delivery ? { status: r.receipt.delivery, reason: r.receipt.deliveryNote } : undefined);
            log(
              `     ✅ settled${sim} ${atomicToUsd(r.receipt.amountAtomic ?? "0")} receipt=${r.receipt.transaction ?? "?"}` +
                `${r.replayed ? " (idempotent replay, no new charge)" : ""}` +
                `${d && d.status !== "passed" ? `\n     ⚠️  paid but failed delivery check: ${"reason" in d ? d.reason : ""}` : ""}`,
            );
            out = {
              status: "settled",
              replayed: r.replayed,
              note: r.replayed ? "Already paid for this in this run; no new charge." : undefined,
              amount: atomicToUsd(r.receipt.amountAtomic ?? "0"),
              receipt: r.receipt.transaction,
              simulated: r.receipt.simulated ?? false,
              explorerUrl: r.receipt.explorerUrl,
              deliveryCheck:
                d?.status === "failed"
                  ? `FAILED — paid but the data is not usable (${"reason" in d ? d.reason : ""}). Do not use it.`
                  : d?.status,
              data: r.data,
            };
            break;
          }
          case "free":
            out = { status: "free", data: r.data };
            break;
          default:
            log(`     ⛔ ${r.status}: ${r.message}`);
            out = { status: r.status, message: r.message };
        }
      } catch (err) {
        log(`     ⛔ error: ${String(err)}`);
        out = { status: "error", message: String(err) };
      }
      return trace("purchase", input, JSON.stringify(out));
    },
  });

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 25,
    system: SYSTEM,
    output_config: { effort: "medium" },
    // If a safety classifier declines a turn, let the API re-run it on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools: [listCatalog, walletStatus, getQuote, purchase],
    messages: [{ role: "user", content: opts.task }],
  });

  const usage: AgentUsage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let final: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    final = message;
    if (opts.onText && message.stop_reason === "tool_use") {
      const text = message.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text.trim())
        .filter(Boolean)
        .join("\n");
      if (text) opts.onText(text);
    }
    usage.requests++;
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
  }
  if (!final) throw new Error("agent produced no response");
  const answer =
    final.stop_reason === "refusal"
      ? "The model declined this task."
      : final.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
  return { answer, stopReason: final.stop_reason, usage };
}
