import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import type { Ledger } from "./ledger";
import { atomicToUsd, usdToAtomic } from "./money";
import type { PaymentService } from "./payments";
import type { PolicyConfig } from "./policy";

const SYSTEM = `You are a purchasing agent with a USDC wallet. You complete the user's task by buying data from paid HTTP APIs that use the x402 protocol.

How to work:
- Discover what is for sale with list_catalog before buying anything.
- Buy only what the task actually needs. Prefer the cheapest resource that answers the question. Do not buy the same thing twice.
- Before a purchase, check the price with get_quote. Give every purchase a specific, honest reason; it is shown to a human approver and written to the audit log.
- A spend policy outside your control enforces a per-transaction cap, a daily budget, a merchant allowlist and human approval above a threshold. If a purchase is denied or declined, do not look for a way around it: tell the user what you could not buy and why, and finish with what you have.
- When you are done, answer the task, then list each payment you made with its amount and transaction link.`;

export async function runAgent(opts: {
  task: string;
  payments: PaymentService;
  ledger: Ledger;
  policy: PolicyConfig;
  networkName: string;
  onEvent?: (line: string) => void;
}) {
  const log = opts.onEvent ?? ((l: string) => console.log(l));
  const client = new Anthropic();

  const listCatalog = betaZodTool({
    name: "list_catalog",
    description: "Fetch a merchant's free product catalog (no payment). Pass the merchant base URL, e.g. http://localhost:4021.",
    inputSchema: z.object({ base_url: z.string().url() }),
    run: async ({ base_url }) => {
      log(`  🔎 list_catalog ${base_url}`);
      const res = await fetch(new URL("/catalog", base_url));
      return await res.text();
    },
  });

  const walletStatus = betaZodTool({
    name: "wallet_status",
    description: "Show the agent wallet address, network, spend limits and how much budget is left today.",
    inputSchema: z.object({}),
    run: async () => {
      const spent = opts.ledger.spentTodayAtomic();
      const budget = usdToAtomic(opts.policy.dailyBudgetUsd);
      return JSON.stringify({
        address: opts.payments.address,
        network: opts.networkName,
        maxPerTransaction: `$${opts.policy.maxPerTransactionUsd}`,
        autoApproveUpTo: `$${opts.policy.approvalThresholdUsd}`,
        dailyBudget: `$${opts.policy.dailyBudgetUsd}`,
        spentToday: atomicToUsd(spent),
        remainingToday: atomicToUsd(budget > spent ? budget - spent : 0n),
        allowedMerchants: opts.policy.allowedMerchants,
      });
    },
  });

  const getQuote = betaZodTool({
    name: "get_quote",
    description: "Check the price of a resource without paying. Returns whether it is free or what it costs.",
    inputSchema: z.object({ url: z.string().url() }),
    run: async ({ url }) => {
      log(`  🏷️  get_quote ${url}`);
      const q = await opts.payments.quote(url);
      return JSON.stringify(
        q.free
          ? { url, free: true }
          : { url, free: false, price: q.amountUsd, currency: "USDC", network: q.requirement?.network, description: q.description },
      );
    },
  });

  const purchase = betaZodTool({
    name: "purchase",
    description:
      "Pay for and fetch a resource. Payment goes through the spend policy and may require human approval. Returns the data and a receipt with the on-chain transaction, or the reason the payment did not happen.",
    inputSchema: z.object({
      url: z.string().url(),
      reason: z.string().min(10).describe("Why this purchase is needed for the user's task. Shown to the human approver."),
    }),
    run: async ({ url, reason }) => {
      log(`  💸 purchase ${url}\n     reason: ${reason}`);
      const r = await opts.payments.purchase(url, reason);
      switch (r.status) {
        case "settled":
          log(`     ✅ settled ${atomicToUsd(r.receipt.amountAtomic ?? "0")}${r.replayed ? " (idempotent replay, no new charge)" : ""} → ${r.receipt.explorerUrl ?? "(no tx hash returned)"}`);
          return JSON.stringify({
            status: "settled",
            replayed: r.replayed,
            note: r.replayed ? "Already paid for this in this run; no new charge. Use the data from your earlier purchase." : undefined,
            amount: atomicToUsd(r.receipt.amountAtomic ?? "0"),
            transaction: r.receipt.transaction,
            explorerUrl: r.receipt.explorerUrl,
            data: r.data,
          });
        case "free":
          return JSON.stringify({ status: "free", data: r.data });
        default:
          log(`     ⛔ ${r.status}: ${r.message}`);
          return JSON.stringify({ status: r.status, message: r.message });
      }
    },
  });

  const runner = client.beta.messages.toolRunner({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    max_iterations: 20,
    system: SYSTEM,
    output_config: { effort: "medium" },
    // If a safety classifier declines a turn, let the API re-run it on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools: [listCatalog, walletStatus, getQuote, purchase],
    messages: [{ role: "user", content: opts.task }],
  });

  const final = await runner.runUntilDone();
  if (final.stop_reason === "refusal") {
    return "The model declined this task.";
  }
  return final.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
