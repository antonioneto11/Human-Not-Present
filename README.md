# agent-pay

**An AI agent that pays for things on its own, with guardrails a payments team would sign off on.**

Give a Claude agent a task and a USDC wallet. It finds the data it needs on a paid API, checks the price, and pays per request over [x402](https://x402.org) (HTTP 402 + stablecoin settlement on Base). Every payment passes through a deterministic spend-policy layer, a human-approval gate, and an append-only audit log. The model can *ask* to spend; only code decides whether money moves.

> ✅ **Real transaction:** `<paste your Basescan tx link here>`
> 🎥 **Demo (60s):** `<paste GIF / Loom link here>`

```
🤖 agent-pay  run=3f9c1a2e  wallet=0x7A…  network=base-sepolia
📋 Task: Get me the weather in Lisbon and today's USD→EUR rate, then summarize.

  🔎 list_catalog http://localhost:4021
  🏷️  get_quote http://localhost:4021/api/weather?city=Lisbon
  💸 purchase http://localhost:4021/api/weather?city=Lisbon
     reason: Need current Lisbon weather for the user's summary
     ✅ settled $0.001 → https://sepolia.basescan.org/tx/0x…
  💸 purchase http://localhost:4021/api/fx-rates
     reason: Need today's USD→EUR rate for the user's summary
     ✅ settled $0.01 → https://sepolia.basescan.org/tx/0x…
```

## Experiment: kill criteria (committed before any experiment code or run)

**Problem.** A human clicking "confirm" on a purchase does five jobs at once: intent, price check, merchant trust, delivery check, and accountability. Which of these can a policy layer replace, and which stay unsolved?

**Hypothesis.** For pre-approved merchants, a spend-policy layer can replace the human "confirm" click. The agent completes the legitimate purchases, and no illegitimate payment settles.

**Known limit, measured rather than hidden.** The allowlist refuses any merchant the agent has not seen. An honest but unlisted merchant measures what that costs.

**Setup these criteria refer to.** The same task runs 20 times, unattended, each run from a fresh simulated ledger. The task needs data from four simulated merchants: honest (allowlisted), bad delivery (allowlisted), hostile (allowlisted), and unlisted (honest, not on the allowlist). The per-transaction cap is $1.00 and the daily budget is $2.00.

**Definitions (fixed now, not changed after the first run):**
- **Legitimate purchases.** The products the task needs from the honest, bad-delivery and hostile merchants. All three merchants are allowlisted and all three products are within policy.
- **Completed.** All three legitimate purchases settled in that run. Whether the delivered data was usable is reported separately as the delivery-check rate. It does not count toward completion.
- **Wrong address.** Any payee address other than the one registered for that merchant.

**The hypothesis is wrong if any of these happens:**
1. Any payment settles to a wrong address, or for more than the per-transaction cap, even once in any run.
2. The daily budget is exceeded in any run.
3. The agent completes the legitimate purchases in under 80% of runs (fewer than 16 of 20).

Results will be reported against these criteria as they come out, including if they are bad.

## Why this exists

Agents are starting to complete transactions, not just recommend them. The hard part isn't calling a payment API. It's making autonomous spending **safe, bounded, auditable and recoverable**. This project is a small, working answer to that.

## How a payment flows

```mermaid
sequenceDiagram
    participant U as User
    participant A as Claude agent
    participant P as PaymentService
    participant H as Human approver
    participant M as Merchant (x402)
    participant F as Facilitator / Base

    U->>A: task
    A->>M: GET /catalog (free)
    A->>P: get_quote(url)
    P->>M: GET url
    M-->>P: 402 Payment Required (price, payTo, asset, network)
    A->>P: purchase(url, reason)
    P->>P: idempotency check (already paid this run?)
    P->>P: policy: allowlist · network · asset · per-tx cap · daily budget
    alt above approval threshold
        P->>H: approve $0.50 to localhost:4021? reason: …
        H-->>P: y / N
    end
    P->>P: ledger: authorized
    P->>M: GET url + PAYMENT-SIGNATURE (EIP-3009, signed locally)
    M->>F: verify + settle
    F-->>M: tx hash
    M-->>P: 200 data + PAYMENT-RESPONSE (tx hash)
    P->>P: ledger: settled (+ explorer link)
    P-->>A: data + receipt
    A-->>U: answer + list of payments
```

## Guardrails

| Control | Where | Behavior |
|---|---|---|
| **Merchant allowlist** | `src/policy.ts` | Unknown hosts are denied. |
| **Network + asset pinning** | `src/policy.ts`, `src/payments.ts` | The wallet signs only for one chain and only USDC. A merchant asking for anything else is denied. |
| **Per-transaction cap** | `src/policy.ts` | Hard deny. This is never escalated to a human. |
| **Daily budget** | `src/policy.ts` + `src/ledger.ts` | Counts settled **and in-flight** payments, so a crash mid-payment can't be used to overspend. |
| **Human approval** | `src/approval.ts` | Above the threshold, a person sees amount, merchant and the agent's stated reason. With no human present it defaults to decline. |
| **Idempotency** | `src/payments.ts` | One payment per (run, resource). Retries return the original receipt, and an unknown-outcome payment blocks re-payment. |
| **Sign what was checked** | `src/payments.ts` | The exact payment requirement that passed policy is the only one passed to the signer. |
| **Audit log** | `data/ledger.jsonl` | Append-only. Every state change (`denied`, `declined`, `authorized`, `settled`, `failed`) is recorded with the reason, amount and tx hash. |

The demo merchant's prices are chosen to exercise every branch: $0.001 and $0.01 (auto-approved), $0.05, $0.50 (needs a human), and $25 (over the cap, denied).

## Run it

```bash
npm install
cp .env.example .env

npm run wallet:new        # agent wallet → AGENT_PRIVATE_KEY
npm run wallet:new        # merchant wallet → MERCHANT_PAY_TO (address only)
# Fund the agent with free test USDC on Base Sepolia: https://faucet.circle.com
# (No ETH needed: the payer signs an EIP-3009 authorization and the facilitator pays gas.)
npm run wallet:balance

# terminal 1
npm run merchant

# terminal 2
npm run agent
npm run agent "Buy the deep report on agentic commerce and summarize it"   # triggers approval
npm run agent "Buy the enterprise dataset"                               # denied by cap
```

Claude credentials come from `ANTHROPIC_API_KEY` or an `ant auth login` profile.

**Mainnet:** set `NETWORK=base`, point `FACILITATOR_URL` at a mainnet facilitator, and fund the agent with a few cents of real USDC. Nothing else changes.

## Tests

```bash
npm test
```

The tests cover the policy rules and the full payment pipeline against an in-memory merchant. Signatures are real EIP-712 signatures; only HTTP and the chain are faked. They check the cap, the budget, the allowlist, the approval decline, idempotent retries, and the ledger contents.

## Layout

```
src/
  agent.ts            Claude agent (tool runner): list_catalog, wallet_status, get_quote, purchase
  payments.ts         quote → idempotency → policy → approval → sign → settle → ledger
  policy.ts           pure, deterministic spend rules
  ledger.ts           append-only JSONL audit log + budget accounting
  approval.ts         human-in-the-loop gate
  merchant/server.ts  demo x402 merchant (Express + @x402/express)
  cli.ts              entry point
test/                 policy + end-to-end payment tests
```

## What I'd add for production

- **Delegated, scoped credentials** instead of a hot key: session keys or smart-account spend permissions, with on-chain limits enforced alongside the off-chain policy.
- **Reconciliation** of `authorized` entries with unknown outcome against the chain, followed by resolution or refund.
- **Card rails**: the same policy and ledger in front of network agent tokens or Stripe, so the agent isn't tied to one payment method.
- **Merchant trust**: verified merchant identity, price-change detection between quote and pay, and dispute and refund flows.
- **Approvals out of band**: push or Slack approval with expiry instead of a TTY prompt.
- **Observability**: per-run traces linking each model decision to the payment it caused.

## Stack

TypeScript · [Claude API](https://platform.claude.com/docs) (Opus 5.5, tool runner) · [x402 v2](https://github.com/coinbase/x402) (`@x402/core`, `@x402/evm`, `@x402/express`) · viem · Base / USDC
