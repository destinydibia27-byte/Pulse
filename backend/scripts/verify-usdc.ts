/**
 * One-time sanity check that the configured USDC address is a real ERC20 on the
 * RPC you're pointed at, with the symbol/decimals Pulse assumes (USDC, 6).
 *
 *   ARBITRUM_SEPOLIA_RPC_URL=... USDC_ADDRESS=0x... npx tsx scripts/verify-usdc.ts
 *
 * Defaults to Circle's documented Arbitrum Sepolia USDC. It also checks the chain
 * id, so pointing this at Arbitrum One (whose USDC is a different, real-money
 * token) fails instead of passing quietly.
 */
import path from "path";
import { createPublicClient, http, parseAbi, isAddress, getAddress } from "viem";
import { arbitrumSepolia } from "viem/chains";

const DEFAULT_USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

async function main() {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), "..", ".env"));
  } catch {
    /* no .env: use the real environment */
  }
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpc) throw new Error("Set ARBITRUM_SEPOLIA_RPC_URL");
  const raw = process.env.USDC_ADDRESS || DEFAULT_USDC;
  if (!isAddress(raw)) throw new Error(`Not a valid address: ${raw} (${raw.length - 2} hex chars)`);
  const address = getAddress(raw);

  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });

  const chainId = await client.getChainId();
  if (chainId !== arbitrumSepolia.id) {
    throw new Error(`RPC is chain ${chainId}, expected Arbitrum Sepolia (${arbitrumSepolia.id}). Refusing to continue.`);
  }

  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`No contract code at ${address} on chain ${chainId}.`);

  const abi = parseAbi([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ]);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi, functionName: "symbol" }),
    client.readContract({ address, abi, functionName: "decimals" }),
  ]);

  console.log({ address, chainId, symbol, decimals });
  if (symbol !== "USDC") throw new Error(`Unexpected symbol "${symbol}"`);
  if (decimals !== 6) throw new Error(`Unexpected decimals ${decimals} (Pulse assumes 6)`);
  console.log("USDC OK");
}

main().catch((e) => {
  console.error("USDC CHECK FAILED:", e.message ?? e);
  process.exit(1);
});
