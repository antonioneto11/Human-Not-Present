import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { loadAgentWalletKey, loadNetwork } from "../config";

const net = loadNetwork();
const { address } = privateKeyToAccount(loadAgentWalletKey());
const client = createPublicClient({ chain: net.name === "base" ? base : baseSepolia, transport: http(net.rpcUrl) });
const bal = await client.readContract({ address: net.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
console.log(`${address} on ${net.name}: ${formatUnits(bal, 6)} USDC`);
