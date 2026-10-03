import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localParts,
  nextRunDate,
  checkSchedule,
  checkChainState,
  markSending,
  markDone,
  markRetry,
  isValidTimeZone,
  MAX_ATTEMPTS_PER_DAY,
  RETRY_BACKOFF_MS,
  type Schedulable,
} from "../src/scheduler";

const USDC = 1_000_000n;
// 2026-09-28 is a Monday, so 2026-10-02 is a Friday.
const FRI_NOON_UTC = new Date("2026-10-02T12:00:00Z");

const auto = (o: Partial<Schedulable> = {}): Schedulable => ({
  status: "active",
  trigger: { day: "friday" },
  condition: { operator: ">", thresholdBaseUnits: (100n * USDC).toString() },
  amountBaseUnits: (10n * USDC).toString(),
  timezone: "UTC",
  expiresAt: 4102444800, // 2100
  ...o,
});

// ------------------------------------------------------------------ localParts
test("localParts: same instant is a different weekday in different timezones", () => {
  const t = new Date("2026-10-02T02:00:00Z"); // Fri 02:00 UTC
  assert.deepEqual(localParts(t, "UTC"), { weekday: "friday", date: "2026-10-02" });
  assert.deepEqual(localParts(t, "Africa/Lagos"), { weekday: "friday", date: "2026-10-02" }); // 03:00
  assert.deepEqual(localParts(t, "Asia/Tokyo"), { weekday: "friday", date: "2026-10-02" }); // 11:00
  assert.deepEqual(localParts(t, "America/New_York"), { weekday: "thursday", date: "2026-10-01" }); // 22:00 Thu
  assert.deepEqual(localParts(t, "Pacific/Kiritimati"), { weekday: "friday", date: "2026-10-02" }); // UTC+14
  assert.deepEqual(localParts(t, "Pacific/Pago_Pago"), { weekday: "thursday", date: "2026-10-01" }); // UTC-11
});

test("localParts: year boundary", () => {
  const t = new Date("2026-12-31T23:30:00Z");
  assert.deepEqual(localParts(t, "UTC"), { weekday: "thursday", date: "2026-12-31" });
  assert.deepEqual(localParts(t, "Africa/Lagos"), { weekday: "friday", date: "2027-01-01" });
});

test("isValidTimeZone", () => {
  assert.equal(isValidTimeZone("Africa/Lagos"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
});

// ----------------------------------------------------------------- nextRunDate
test("nextRunDate: from Monday, next Friday is 4 days out", () => {
  assert.equal(nextRunDate("friday", "UTC", new Date("2026-09-28T09:00:00Z"), false), "2026-10-02");
});

test("nextRunDate: on the day and not yet done -> today; once done -> a week later", () => {
  assert.equal(nextRunDate("friday", "UTC", FRI_NOON_UTC, false), "2026-10-02");
  assert.equal(nextRunDate("friday", "UTC", FRI_NOON_UTC, true), "2026-10-09");
});

test("nextRunDate: respects timezone (still Thursday in New York)", () => {
  const t = new Date("2026-10-02T02:00:00Z");
  assert.equal(nextRunDate("friday", "America/New_York", t, false), "2026-10-02"); // tomorrow, local
  assert.equal(nextRunDate("friday", "Africa/Lagos", t, false), "2026-10-02"); // today, local
});

test("nextRunDate: crosses the year boundary", () => {
  assert.equal(nextRunDate("friday", "UTC", new Date("2026-12-31T12:00:00Z"), false), "2027-01-01");
});

test("nextRunDate: DST change never skips or repeats a day (US fall-back is 2026-11-01)", () => {
  const sat = new Date("2026-10-31T12:00:00Z");
  assert.equal(nextRunDate("sunday", "America/New_York", sat, false), "2026-11-01");
  assert.equal(nextRunDate("monday", "America/New_York", sat, false), "2026-11-02");
  // and every weekday resolves within 7 days from any starting day
  for (let i = 0; i < 14; i++) {
    const now = new Date(Date.UTC(2026, 9, 25 + i, 12));
    for (const d of ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const) {
      const next = nextRunDate(d, "America/New_York", now, false);
      const gap = (new Date(next).getTime() - new Date(localParts(now, "America/New_York").date).getTime()) / 86_400_000;
      assert.ok(gap >= 0 && gap <= 6, `${d} from day ${i}: gap ${gap}`);
    }
  }
});

// -------------------------------------------------------------- checkSchedule
test("checkSchedule: due on the right day", () => {
  const r = checkSchedule(auto(), FRI_NOON_UTC);
  assert.deepEqual(r, { go: true, localDate: "2026-10-02" });
});

test("checkSchedule: wrong day", () => {
  const r = checkSchedule(auto(), new Date("2026-10-01T12:00:00Z"));
  assert.equal(r.go, false);
  assert.match((r as any).reason, /not scheduled today/);
});

test("checkSchedule: uses the automation's timezone, not the server's", () => {
  const t = new Date("2026-10-02T02:00:00Z");
  assert.equal(checkSchedule(auto({ timezone: "America/New_York" }), t).go, false); // Thursday there
  assert.equal(checkSchedule(auto({ timezone: "Africa/Lagos" }), t).go, true); // Friday there
});

test("checkSchedule: paused / cancelled / expired are never due", () => {
  assert.equal(checkSchedule(auto({ status: "paused" }), FRI_NOON_UTC).go, false);
  assert.equal(checkSchedule(auto({ status: "cancelled" }), FRI_NOON_UTC).go, false);
  assert.equal(checkSchedule(auto({ expiresAt: Math.floor(FRI_NOON_UTC.getTime() / 1000) }), FRI_NOON_UTC).go, false);
  assert.equal(checkSchedule(auto({ expiresAt: Math.floor(FRI_NOON_UTC.getTime() / 1000) + 1 }), FRI_NOON_UTC).go, true);
});

test("checkSchedule: invalid timezone fails closed, does not throw", () => {
  const r = checkSchedule(auto({ timezone: "Mars/Olympus" }), FRI_NOON_UTC);
  assert.equal(r.go, false);
});

test("checkSchedule: already done today blocks; a new week does not", () => {
  const done = auto({ run: markDone(undefined, "2026-10-02") });
  assert.equal(checkSchedule(done, FRI_NOON_UTC).go, false);
  assert.equal(checkSchedule(done, new Date("2026-10-09T12:00:00Z")).go, true);
});

test("checkSchedule: 'sending' (crash / unconfirmed) blocks the rest of that day", () => {
  const a = auto({ run: markSending(undefined, "2026-10-02") });
  const r = checkSchedule(a, new Date("2026-10-02T23:59:00Z"));
  assert.equal(r.go, false);
  assert.match((r as any).reason, /not resending/);
});

test("checkSchedule: retry respects backoff and the daily attempt cap", () => {
  const failedAt = FRI_NOON_UTC;
  let run = markRetry(markSending(undefined, "2026-10-02"), "2026-10-02", failedAt);
  const a = auto({ run });
  assert.equal(checkSchedule(a, new Date(failedAt.getTime() + RETRY_BACKOFF_MS - 1)).go, false);
  assert.equal(checkSchedule(a, new Date(failedAt.getTime() + RETRY_BACKOFF_MS)).go, true);

  // exhaust attempts
  run = { date: "2026-10-02", state: "retry", attempts: MAX_ATTEMPTS_PER_DAY, retryAfter: new Date(0).toISOString() };
  const r = checkSchedule(auto({ run }), FRI_NOON_UTC);
  assert.equal(r.go, false);
  assert.match((r as any).reason, /gave up/);
});

// ------------------------------------------------------------ run-state moves
test("markSending increments within a day and resets on a new day", () => {
  const a = markSending(undefined, "2026-10-02");
  assert.equal(a.attempts, 1);
  const b = markSending(markRetry(a, "2026-10-02", FRI_NOON_UTC), "2026-10-02");
  assert.equal(b.attempts, 2);
  const c = markSending(b, "2026-10-09");
  assert.equal(c.attempts, 1);
});

test("markDone / markRetry keep the attempt count", () => {
  const s = markSending(markSending(undefined, "2026-10-02"), "2026-10-02");
  assert.equal(markDone(s, "2026-10-02").attempts, 2);
  assert.equal(markRetry(s, "2026-10-02", FRI_NOON_UTC).attempts, 2);
});

// ------------------------------------------------------------ checkChainState
const snap = (balance: bigint | null, allowance: bigint | null) => ({ balance, allowance });

test("checkChainState: sends when condition holds and funds/allowance cover it", () => {
  assert.deepEqual(checkChainState(auto(), snap(250n * USDC, 1000n * USDC)), { go: true });
});

test("checkChainState: unreadable balance or allowance -> no send", () => {
  assert.equal(checkChainState(auto(), snap(null, 1000n * USDC)).go, false);
  assert.equal(checkChainState(auto(), snap(250n * USDC, null)).go, false);
});

test("checkChainState: condition boundary is strict for '>'", () => {
  assert.equal(checkChainState(auto(), snap(100n * USDC, 1000n * USDC)).go, false);
  assert.equal(checkChainState(auto(), snap(100n * USDC + 1n, 1000n * USDC)).go, true);
});

test("checkChainState: balance below send amount, or allowance below send amount -> no send", () => {
  const lowCond = auto({ condition: { operator: ">", thresholdBaseUnits: "0" } });
  const r1 = checkChainState(lowCond, snap(5n * USDC, 1000n * USDC));
  assert.equal(r1.go, false);
  assert.match((r1 as any).reason, /below the send amount/);
  const r2 = checkChainState(auto(), snap(250n * USDC, 5n * USDC));
  assert.equal(r2.go, false);
  assert.match((r2 as any).reason, /allowance/);
});

test("checkChainState: exactly enough allowance is enough", () => {
  assert.equal(checkChainState(auto(), snap(250n * USDC, 10n * USDC)).go, true);
});
