import { DEMO_SAVINGS_FALLBACK, requireAddress, resolveUsdcAddress } from "./constants";
import type { ApprovedRecipients } from "./policyEngine";

/**
 * Server-side app configuration shared by the API routes, so "which token" and
 * "which recipients are approved" have exactly one definition. Addresses are
 * validated at load: a typo fails loudly instead of mid-transaction.
 *
 * MVP: recipients are hardcoded for the single "demo" user. In a real build this
 * comes from a wallet-settings flow the user completes once, out of band.
 */
export const USDC_ADDRESS = resolveUsdcAddress();

export const APPROVED_RECIPIENTS: ApprovedRecipients = {
  demo: {
    savings: requireAddress(
      "DEMO_SAVINGS_ADDRESS",
      process.env.DEMO_SAVINGS_ADDRESS || DEMO_SAVINGS_FALLBACK
    ),
  },
};

/** True when the server can talk to the deployed contract (RPC + contract address). */
export function chainConfigured(): boolean {
  return Boolean(process.env.ARBITRUM_SEPOLIA_RPC_URL && process.env.PULSE_CONTRACT_ADDRESS);
}
