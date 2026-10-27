/**
 * Small in-memory rate limiter (fixed window). Good enough for ONE server instance: counters reset
 * on restart and are not shared between instances. Two layers: a per-caller key (best effort: the
 * caller's IP) and a global ceiling per route, so a spoofed or rotating key cannot run up unlimited
 * cost on routes that spend money (the AI parser) or database calls.
 */
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;

function hit(key: string, limit: number, windowMs: number, now: number): boolean {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      if (buckets.size >= MAX_BUCKETS) buckets.clear(); // under attack: forget everyone rather than grow
    }
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

export interface Limit { perCaller: number; global: number; windowMs: number }

/** Returns true if the request is allowed. */
export function allow(route: string, caller: string, limit: Limit, now = Date.now()): boolean {
  const okCaller = hit(`c:${route}:${caller}`, limit.perCaller, limit.windowMs, now);
  const okGlobal = hit(`g:${route}`, limit.global, limit.windowMs, now);
  return okCaller && okGlobal;
}

/** Best-effort caller key from proxy headers. Spoofable, which is why a global ceiling also exists. */
export function callerKey(headers: { get(name: string): string | null }): string {
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}

export function resetRateLimits(): void { buckets.clear(); }
