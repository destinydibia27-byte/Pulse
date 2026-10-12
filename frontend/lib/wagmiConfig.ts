import { http, createConfig } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { resolveUsdcAddress } from "./constants";

/**
 * MVP: browser injected wallet only (MetaMask etc). Add walletConnect()
 * here later if you want mobile-wallet support — it needs a WalletConnect
 * Cloud project id, deliberately left out to keep zero-config setup working.
 */
export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia],
  connectors: [injected()],
  transports: {
    [arbitrumSepolia.id]: http(
      process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL || undefined
    ),
  },
});

export const PULSE_CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS ??
  "") as `0x${string}`;
export const USDC_ADDRESS = resolveUsdcAddress();
