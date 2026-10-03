import { recoverMessageAddress, type Address } from "viem";

/**
 * Wallet-signature auth for API actions. No RPC call, no gas, works fully offline:
 * this is local cryptographic signature recovery (EIP-191 personal_sign), not an
 * on-chain check. It proves "whoever sent this request controls this private key
 * right now" — it does NOT by itself prove they own the on-chain permission; the
 * caller must separately check the recovered address against the record's owner.
 *
 * Known limitation: this only verifies EOA (regular wallet) signatures. A smart
 * contract wallet (Safe, etc.) as the automation owner would need ERC-1271
 * verification instead, which requires an RPC call. Not implemented here.
 */

export const AUTH_WINDOW_MS = 5 * 60 * 1000;

/** Message signed to register a new automation. Binds the signature to this exact permission. */
export function buildRegisterMessage(onchainId: string, owner: string, timestamp: number): string {
  return `Pulse: register automation\nonchainId: ${onchainId}\nowner: ${owner}\ntimestamp: ${timestamp}`;
}

/** Message signed for pause/resume/cancel/fire. Binds the signature to this exact action. */
export function buildActionMessage(automationId: string, action: string, timestamp: number): string {
  return `Pulse: ${action} automation\nid: ${automationId}\ntimestamp: ${timestamp}`;
}

export type AuthResult = { ok: true; signer: Address } | { ok: false; reason: string };

export interface AuthInput {
  message: string;
  signature: `0x${string}`;
  expectedSigner: Address;
  timestamp: number;
}

/**
 * Verifies the signature recovers to `expectedSigner` AND that `timestamp` is
 * recent. The timestamp window is what makes a captured request unusable later —
 * without it, anyone who ever saw a valid signed request could replay it forever.
 */
export async function verifyAuth(input: AuthInput, now: number = Date.now()): Promise<AuthResult> {
  const { message, signature, expectedSigner, timestamp } = input;

  if (!Number.isFinite(timestamp)) return { ok: false, reason: "Missing or invalid timestamp." };
  if (Math.abs(now - timestamp) > AUTH_WINDOW_MS) {
    return { ok: false, reason: "Signature has expired. Please try again." };
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, reason: "Malformed signature." };
  }

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    return { ok: false, reason: "Could not recover a signer from that signature." };
  }

  if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
    return { ok: false, reason: "Signature was not made by the expected wallet." };
  }
  return { ok: true, signer: recovered };
}
