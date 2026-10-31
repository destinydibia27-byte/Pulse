import { getPublicClient } from "./chain";
import type { SmartAccountVerifier } from "./auth";

/**
 * Server-side ERC-1271 check for automations owned by a smart account (e.g. a ZeroDev Kernel
 * account). It asks the chain whether the account accepts the signature, using the same RPC
 * the rest of the server already uses (ARBITRUM_SEPOLIA_RPC_URL).
 *
 * Fails closed: no RPC configured, an RPC error, or a "no" all mean "not verified".
 * viem's verifyMessage understands deployed accounts (ERC-1271) and not-yet-deployed ones (ERC-6492).
 */
export const verifySmartAccount: SmartAccountVerifier = async ({ address, message, signature }) => {
  try {
    return await getPublicClient().verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
};
