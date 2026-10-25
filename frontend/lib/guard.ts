import { NextRequest, NextResponse } from "next/server";
import { allow, callerKey, type Limit } from "./rateLimit";

/**
 * Per-route rate limits for the public endpoints. Per-caller numbers are best effort (the caller is
 * identified by proxy headers, which can be spoofed), so every route also has a global ceiling that
 * bounds the total cost no matter how many callers there appear to be. Single server instance only.
 */
export const LIMITS = {
  parse: { perCaller: 15, global: 240, windowMs: 60_000 },        // can call a paid AI model
  policyCheck: { perCaller: 30, global: 600, windowMs: 60_000 },  // reads the chain
  list: { perCaller: 120, global: 3000, windowMs: 60_000 },
  write: { perCaller: 10, global: 200, windowMs: 60_000 },        // signed writes: register, recipients, actions
} satisfies Record<string, Limit>;

/** Optional multiplier for every limit (RATE_LIMIT_SCALE=2 doubles them). Default 1. */
function scaled(limit: Limit): Limit {
  const k = Number(process.env.RATE_LIMIT_SCALE);
  if (!Number.isFinite(k) || k <= 0 || k === 1) return limit;
  return { ...limit, perCaller: Math.ceil(limit.perCaller * k), global: Math.ceil(limit.global * k) };
}

/** Returns a 429 response when the caller is over the limit, otherwise null. */
export function rateLimited(req: NextRequest, route: keyof typeof LIMITS): NextResponse | null {
  if (allow(route, callerKey(req.headers), scaled(LIMITS[route]))) return null;
  return NextResponse.json(
    { ok: false, reason: "Too many requests. Wait a minute and try again." },
    { status: 429, headers: { "Retry-After": "60" } }
  );
}

/** Wallet address -> the key every per-user record is filed under. Always lower case. */
export const userKey = (address: string): string => address.toLowerCase();

/** Most active or paused automations one wallet may have at a time (testnet fair use). */
export function maxAutomationsPerOwner(): number {
  const n = Number(process.env.MAX_AUTOMATIONS_PER_OWNER);
  return Number.isInteger(n) && n > 0 ? n : 10;
}
