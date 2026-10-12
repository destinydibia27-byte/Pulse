import type { Intent } from "./schema";
import { compare } from "./policyEngine";

/**
 * Pure scheduling + eligibility logic. No I/O, no clock reads (callers pass `now`),
 * so every rule here is unit-testable and the worker is just plumbing around it.
 *
 * Semantics (deliberately simple and stated plainly to users):
 *  - "Every <day>" means that calendar day in the automation's own IANA timezone. This code
 *    supports any zone, but registration always stores "UTC": the contract enforces the
 *    weekday in UTC and cannot know a user's zone, so the off-chain schedule must agree.
 *  - On that day the worker keeps checking; it fires the FIRST time the balance
 *    condition holds, and at most ONCE per day.
 *  - At-most-once beats at-least-once: this moves money, so if we can't tell whether
 *    a send happened we do NOT resend automatically that day.
 */

export const WEEKDAYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const MAX_ATTEMPTS_PER_DAY = 3;
export const RETRY_BACKOFF_MS = 5 * 60 * 1000;

export type Operator = Intent["condition"]["operator"];

export interface RunState {
  date: string; // local calendar date (YYYY-MM-DD, in the automation's timezone) this state refers to
  state: "sending" | "done" | "retry";
  attempts: number;
  retryAfter?: string; // ISO time
}

/** The subset of an automation record the scheduler needs. */
export interface Schedulable {
  status: "active" | "paused" | "cancelled" | "expired";
  trigger: { day: Weekday };
  condition: { operator: Operator; thresholdBaseUnits: string };
  amountBaseUnits: string;
  timezone: string;
  expiresAt: number; // unix seconds
  run?: RunState;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date + weekday of `now` as seen in `timeZone`. */
export function localParts(now: Date, timeZone: string): { weekday: Weekday; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    weekday: get("weekday").toLowerCase() as Weekday,
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function weekdayOfDate(ymd: string): Weekday {
  const [y, m, d] = ymd.split("-").map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7];
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Next calendar date (YYYY-MM-DD, in `timeZone`) this automation is due.
 * Pure calendar arithmetic, so DST shifts can't skip or repeat a day.
 * Does not know whether the condition will hold that day.
 */
export function nextRunDate(
  day: Weekday,
  timeZone: string,
  now: Date,
  alreadyDoneToday: boolean
): string {
  const today = localParts(now, timeZone).date;
  for (let k = 0; k <= 7; k++) {
    const candidate = addDays(today, k);
    if (weekdayOfDate(candidate) === day && !(k === 0 && alreadyDoneToday)) return candidate;
  }
  throw new Error("unreachable: a weekday always occurs within 8 days");
}

export type ScheduleDecision =
  | { go: true; localDate: string }
  | { go: false; reason: string };

/** Step 1 (no network): is this automation due to be considered right now? */
export function checkSchedule(a: Schedulable, now: Date): ScheduleDecision {
  if (a.status !== "active") return { go: false, reason: `status is ${a.status}` };
  if (Math.floor(now.getTime() / 1000) >= a.expiresAt) return { go: false, reason: "expired" };
  if (!isValidTimeZone(a.timezone)) return { go: false, reason: `invalid timezone "${a.timezone}"` };

  const { weekday, date } = localParts(now, a.timezone);
  if (weekday !== a.trigger.day) return { go: false, reason: `not scheduled today (${weekday})` };

  const run = a.run;
  if (run && run.date === date) {
    if (run.state === "done") return { go: false, reason: "already ran today" };
    if (run.state === "sending") {
      return {
        go: false,
        reason: "an earlier attempt today was sent but never confirmed; not resending automatically",
      };
    }
    if (run.attempts >= MAX_ATTEMPTS_PER_DAY) {
      return { go: false, reason: `gave up for today after ${run.attempts} failed attempts` };
    }
    if (run.retryAfter && now.getTime() < new Date(run.retryAfter).getTime()) {
      return { go: false, reason: "backing off after a failed attempt" };
    }
  }
  return { go: true, localDate: date };
}

export type ChainDecision = { go: true } | { go: false; reason: string };

/** Step 2 (after reading chain state): should it actually send right now? */
export function checkChainState(
  a: Schedulable,
  snap: { balance: bigint | null; allowance: bigint | null }
): ChainDecision {
  if (snap.balance === null) return { go: false, reason: "balance could not be read" };
  if (snap.allowance === null) return { go: false, reason: "allowance could not be read" };

  if (!compare(snap.balance, a.condition.operator, BigInt(a.condition.thresholdBaseUnits))) {
    return { go: false, reason: "balance condition not met" };
  }
  const amount = BigInt(a.amountBaseUnits);
  if (snap.balance < amount) return { go: false, reason: "balance is below the send amount" };
  if (snap.allowance < amount) return { go: false, reason: "USDC allowance is below the send amount" };
  return { go: true };
}

// ---- run-state transitions (pure) ----

function sameDay(run: RunState | undefined, date: string) {
  return run && run.date === date ? run : undefined;
}

/** Written BEFORE any send, so a crash mid-send can never cause an automatic resend. */
export function markSending(prev: RunState | undefined, date: string): RunState {
  return { date, state: "sending", attempts: (sameDay(prev, date)?.attempts ?? 0) + 1 };
}
export function markDone(prev: RunState | undefined, date: string): RunState {
  return { date, state: "done", attempts: sameDay(prev, date)?.attempts ?? 1 };
}
export function markRetry(prev: RunState | undefined, date: string, now: Date): RunState {
  return {
    date,
    state: "retry",
    attempts: sameDay(prev, date)?.attempts ?? 1,
    retryAfter: new Date(now.getTime() + RETRY_BACKOFF_MS).toISOString(),
  };
}
