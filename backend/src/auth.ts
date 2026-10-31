import { recoverMessageAddress, type Address } from "viem";

/**
 * Wallet-signature auth for API actions. No RPC call, no gas, works fully offline:
 * this is local cryptographic signature recovery (EIP-191 personal_sign), not an
 * on-chain check. It proves "whoever sent this request controls this private key
 * right now" — it does NOT by itself prove they own the on-chain permission; the
 * caller must separately check the recovered address against the record's owner.
 *
 * Smart-account owners (for example a ZeroDev Kernel account) cannot be checked by
 * local recovery: their signatures are validated by the account contract itself
 * (ERC-1271), which needs an RPC call. The caller supplies that check as
 * `verifySmartAccount`; without it only regular 65-byte wallet signatures pass.
 */

export const AUTH_WINDOW_MS = 5 * 60 * 1000;

/** Message signed to register a new automation. Binds the signature to this exact permission. */
export function buildRegisterMessage(onchainId: string, owner: string, timestamp: number): string {
  return `Volo: register automation\nonchainId: ${onchainId}\nowner: ${owner}\ntimestamp: ${timestamp}`;
}

/** Message signed for pause/resume/cancel/fire. Binds the signature to this exact action. */
export function buildActionMessage(automationId: string, action: string, timestamp: number): string {
  return `Volo: ${action} automation\nid: ${automationId}\ntimestamp: ${timestamp}`;
}

/** Message signed to save (or replace) one of the owner's recipients. Binds label, address, owner and time. */
export function buildRecipientSetMessage(owner: string, label: string, address: string, timestamp: number): string {
  return `Volo: save recipient\nowner: ${owner}\nlabel: ${label}\naddress: ${address}\ntimestamp: ${timestamp}`;
}

/** Message signed to remove one of the owner's recipients. */
export function buildRecipientRemoveMessage(owner: string, label: string, timestamp: number): string {
  return `Volo: remove recipient\nowner: ${owner}\nlabel: ${label}\ntimestamp: ${timestamp}`;
}

export type AuthResult = { ok: true; signer: Address } | { ok: false; reason: string };

/** Asks the owner's account contract whether `signature` is valid for `message` (ERC-1271). */
export type SmartAccountVerifier = (args: {
  address: Address;
  message: string;
  signature: `0x${string}`;
}) => Promise<boolean>;

export interface AuthInput {
  message: string;
  signature: `0x${string}`;
  expectedSigner: Address;
  timestamp: number;
  /** Optional ERC-1271 check, used only when the signature is not a plain wallet signature of the owner. */
  verifySmartAccount?: SmartAccountVerifier;
}

/**
 * Verifies the signature recovers to `expectedSigner` AND that `timestamp` is
 * recent. The timestamp window is what makes a captured request unusable later —
 * without it, anyone who ever saw a valid signed request could replay it forever.
 */
export async function verifyAuth(input: AuthInput, now: number = Date.now()): Promise<AuthResult> {
  const { message, signature, expectedSigner, timestamp, verifySmartAccount } = input;

  if (!Number.isFinite(timestamp)) return { ok: false, reason: "Missing or invalid timestamp." };
  if (Math.abs(now - timestamp) > AUTH_WINDOW_MS) {
    return { ok: false, reason: "Signature has expired. Please try again." };
  }
  // A plain wallet signature is exactly 65 bytes. Smart-account signatures are longer (or
  // differently framed) but never shorter than that, and are bounded here to keep requests small.
  if (!/^0x(?:[0-9a-fA-F]{2}){65,4096}$/.test(signature)) {
    return { ok: false, reason: "Malformed signature." };
  }
  const isPlainSignature = signature.length === 132;

  let recoverFailed = false;
  if (isPlainSignature) {
    try {
      const recovered = await recoverMessageAddress({ message, signature });
      if (recovered.toLowerCase() === expectedSigner.toLowerCase()) return { ok: true, signer: recovered };
    } catch {
      recoverFailed = true;
    }
  }

  // Not signed directly by the owner's key. If the owner is a smart account, ask the account itself.
  if (verifySmartAccount) {
    let valid = false;
    try {
      valid = await verifySmartAccount({ address: expectedSigner, message, signature });
    } catch {
      valid = false; // an RPC failure must fail closed, never open
    }
    if (valid) return { ok: true, signer: expectedSigner };
  }

  if (!isPlainSignature) return { ok: false, reason: "Signature was not made by the expected wallet." };
  if (recoverFailed) return { ok: false, reason: "Could not recover a signer from that signature." };
  return { ok: false, reason: "Signature was not made by the expected wallet." };
}
