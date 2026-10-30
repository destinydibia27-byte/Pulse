/**
 * When Volo asks a question ("Which day should it run?"), a short answer ("Friday") should finish the
 * original sentence rather than start a new request. This decides what text to send to the parser.
 *
 * A reply is treated as a brand-new request, not an answer, when it is long or already contains two
 * or more numbers (an amount and a balance, as every full request does).
 */
import { countNumbers } from "./numbers";

export const FOLLOW_UP_MAX_REPLY = 80;
export const COMBINED_MAX = 600;

export function combineFollowUp(source: string | null | undefined, reply: string): string {
  const r = reply.trim();
  if (!source) return r;
  const numbers = countNumbers(r);
  if (r.length > FOLLOW_UP_MAX_REPLY || numbers >= 2) return r; // a fresh request
  const base = source.trim().replace(/[\s.,;]+$/, "");
  const joined = `${base}. ${r}`;
  return joined.length > COMBINED_MAX ? r : joined;
}
