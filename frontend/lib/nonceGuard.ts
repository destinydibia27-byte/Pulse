/**
 * In-memory replay guard: a valid signature can only be used ONCE. Without this, a
 * captured signed request stays replayable for the whole AUTH_WINDOW_MS window —
 * harmless for idempotent actions (cancel-twice is a no-op) but not for "fire",
 * which could be replayed to trigger extra attempts within the window.
 *
 * MVP limitation: in-memory and per-process. It resets on restart and does not
 * work across multiple server instances. Fine for a single demo deployment; move
 * to a shared store (Redis, a DB table) before running more than one instance.
 */

const seen = new Map<string, number>(); // signature -> expiry (ms epoch)

export function keyFor(signature: string): string {
  return signature.toLowerCase();
}

/** Returns true and records it if this is the first use; false if already used. */
export function consumeOnce(signature: string, expiresAt: number): boolean {
  const k = keyFor(signature);
  if (seen.has(k)) return false;
  seen.set(k, expiresAt);
  return true;
}

/** Call periodically (or opportunistically) to bound memory use. */
export function sweepExpired(now: number = Date.now()): void {
  for (const [k, exp] of seen) {
    if (exp < now) seen.delete(k);
  }
}

/** Test-only: reset all state between test cases. */
export function _resetForTests(): void {
  seen.clear();
}
