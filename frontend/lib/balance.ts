import { createPublicClient, http, isAddress, getAddress } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ERC20_ABI } from "./abi";

export type BalanceRead =
  | { status: "checked"; balance: bigint }
  | { status: "skipped"; reason: string };

/**
 * Server-side read of the owner's current token balance, for the "Check rule"
 * step only. This is informational: nothing here grants or limits authority
 * (the contract does that), so a failed or skipped read never blocks anything;
 * it just means the UI says "balance not checked" instead of guessing.
 *
 * Error text is deliberately generic: RPC URLs commonly embed API keys and viem
 * error messages can include them, so they must never be echoed to the browser.
 */
export async function readTokenBalance(
  owner: string | undefined,
  asset: `0x${string}`
): Promise<BalanceRead> {
  if (!owner) {
    return { status: "skipped", reason: "Connect a wallet to check your current balance." };
  }
  if (!isAddress(owner)) {
    return { status: "skipped", reason: "The wallet address provided was not valid." };
  }
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpc) {
    return {
      status: "skipped",
      reason: "No server RPC configured (ARBITRUM_SEPOLIA_RPC_URL), so balance was not checked.",
    };
  }

  try {
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(rpc, { timeout: 8_000, retryCount: 1 }),
    });
    const balance = await client.readContract({
      address: asset,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [getAddress(owner)],
    });
    return { status: "checked", balance };
  } catch (err) {
    console.warn("[balance] read failed:", (err as Error).name); // name only: message may contain the RPC URL
    return {
      status: "skipped",
      reason: "Could not read your balance from the network right now.",
    };
  }
}
