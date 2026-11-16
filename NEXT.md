# Next: the testnet run

The first experiment uses **simulated settlement**. Everything up to settlement is real x402: the 402 response, the EIP-3009 payment signed by the agent's key, and signature, payee, amount, nonce and balance verification. The last step, moving USDC, is a local ledger. The immediate second step is to replace that step with a real testnet facilitator and run the same experiment again.

## What changes

Only the settlement implementation. Merchants settle through x402's `FacilitatorClient` interface (`src/settlement/index.ts`):

```ts
createFacilitator("simulated")                                         // today
createFacilitator("testnet", { facilitatorUrl: "https://x402.org/facilitator" })  // next
```

The agent, the policy layer, the payment flow, the merchants, the delivery check and the scorer stay as they are. The kill criteria and the 80% completion threshold stay as committed.

## Steps

1. `npm run wallet:new`, then fund the agent with Base Sepolia test USDC from https://faucet.circle.com. No ETH is needed, because the facilitator pays gas.
2. Give each merchant a real payee address that we control. The current payees are placeholders, so funds sent to them would be unrecoverable.
3. Add a `--settlement testnet` flag to the runner that uses `HTTPFacilitatorClient` and reads the agent's balance over RPC instead of from the simulated ledger.
4. Ground truth moves from `sim-settlement.json` to the chain. The scorer reads the agent's USDC `Transfer` events on Base Sepolia instead of simulated receipts.
5. Run the same 20 runs. Report the same rates next to the simulated results, with real Basescan links for every settled payment.

## What this tests that the simulation can't

- Settlement latency and failures, such as facilitator timeouts and reverted transactions. These exercise the "authorized, outcome unknown" path in the ledger.
- Whether the daily-budget accounting holds when settlement is slow, because in-flight payments count against the budget.
- Real receipts that a third party can check.

Cost: under $0.50 of testnet USDC (free) for 20 runs, plus Claude API usage similar to the simulated run.
