import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const { address } = privateKeyToAccount(key);
console.log(`Address:     ${address}`);
console.log(`Private key: ${key}`);
console.log(`\nPut the key in .env as AGENT_PRIVATE_KEY (or MERCHANT_PAY_TO=<address> for the merchant).`);
console.log(`Fund the agent with test USDC on Base Sepolia: https://faucet.circle.com`);
console.log(`(No ETH needed: x402 "exact" payments are gasless for the payer — the facilitator submits the tx.)`);
