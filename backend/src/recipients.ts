import { getAddress, isAddress } from "viem";

/**
 * Rules for a user's saved recipients ("savings" -> 0x...). Pure functions, shared by the API and tests.
 * The parser can only ever name a label; the address behind it is whatever THIS user saved, and the
 * contract locks it in when the permission is created.
 */

export const MAX_RECIPIENTS_PER_USER = 10;
const LABEL_RE = /^[a-z0-9][a-z0-9 _-]{0,31}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** Lower-cases, trims and collapses spaces, then checks the result. Returns null if it is not a usable label. */
export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return LABEL_RE.test(label) ? label : null;
}

export type AddressCheck = { ok: true; address: `0x${string}` } | { ok: false; reason: string };

/**
 * `forbidden` lists addresses that must never be a recipient because funds sent there are stuck or
 * are the system's own (the token contract, the Volo contract, the executor, the user's own wallet).
 */
export function checkRecipientAddress(raw: unknown, forbidden: { address: string; why: string }[] = []): AddressCheck {
  if (typeof raw !== "string" || !isAddress(raw, { strict: false })) {
    return { ok: false, reason: "That is not a valid wallet address." };
  }
  // All-lower-case is accepted as is. A mixed-case address must carry a correct checksum: that catches most typos.
  if (!isAddress(raw, { strict: true })) {
    return { ok: false, reason: "The capital letters in that address do not match its checksum. Re-copy it from your wallet." };
  }
  const address = getAddress(raw);
  if (address.toLowerCase() === ZERO) return { ok: false, reason: "The zero address cannot be a recipient." };
  for (const f of forbidden) {
    if (f.address && f.address.toLowerCase() === address.toLowerCase()) return { ok: false, reason: f.why };
  }
  return { ok: true, address };
}
