import { resolveUsdcAddress } from "./constants";
import { getRecipients } from "./db";
import type { ApprovedRecipients } from "./policyEngine";

/**
 * Server-side app configuration shared by the API routes, so "which token" and
 * "which recipients are approved" have exactly one definition.
 *
 * Recipients are PER USER: each wallet saves its own ("savings" -> 0x...) in Settings, signed with
 * that wallet, and only that wallet's book is ever consulted for its rules.
 */
export const USDC_ADDRESS = resolveUsdcAddress();

/** The approved-recipient map for one user, in the shape the policy engine expects. */
export async function approvedRecipientsFor(userId: string): Promise<ApprovedRecipients> {
  return { [userId]: await getRecipients(userId) };
}

/** True when the server can talk to the deployed contract (RPC + contract address). */
export function chainConfigured(): boolean {
  return Boolean(process.env.ARBITRUM_SEPOLIA_RPC_URL && process.env.PULSE_CONTRACT_ADDRESS);
}
