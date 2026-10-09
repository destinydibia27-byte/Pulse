import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processAutomation,
  pollOnce,
  parsePollInterval,
  DEFAULT_POLL_INTERVAL_MS,
  type WorkerDeps,
} from "../src/triggerWorker";
import { ExecutionUncertainError } from "../src/chain";
import { RETRY_BACKOFF_MS, MAX_ATTEMPTS_PER_DAY } from "../src/scheduler";
import type { AutomationRecord } from "../src/db";

const USDC = 1_000_000n;
const OWNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const TOKEN = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;
const FRI = new Date("2026-10-02T12:00:00Z");
const THU = new Date("2026-10-01T12:00:00Z");
const NEXT_FRI = new Date("2026-10-09T12:00:00Z");

const rec = (o: Partial<AutomationRecord> = {}): AutomationRecord => ({
  id: "demo-0",
  onchainId: "0",
  userId: "demo",
  label: "Weekly savings",
  recipientLabel: "savings",
  amountBaseUnits: (10n * USDC).toString(),
  owner: OWNER,
  asset: TOKEN,
  trigger: { day: "friday" },
  condition: { operator: ">", thresholdBaseUnits: (100n * USDC).toString() },
  timezone: "UTC",
  expiresAt: 4102444800,
  status: "active",
  createdAt: "2026-09-28T00:00:00Z",
  ...o,
});

type Exec = WorkerDeps["execute"];
const ok: Exec = async () => ({ hash: "0xabc", outcome: { status: "success", amount: 10n * USDC } });

function harness(records: AutomationRecord[], start = FRI) {
  let now = start;
  const calls = { balance: 0, allowance: 0, execute: 0 };
  const s = {
    balance: 250n * USDC as bigint,
    allowance: 1000n * USDC as bigint,
    balanceThrows: false,
    exec: ok as Exec,
  };
  const deps: WorkerDeps = {
    now: () => now,
    listActive: async () => records.filter((r) => r.status === "active"),
    update: async (id, fn) => {
      const r = records.find((x) => x.id === id);
      if (r) fn(r);
      return r;
    },
    readBalance: async () => {
      calls.balance++;
      if (s.balanceThrows) throw new Error("rpc down");
      return s.balance;
    },
    readAllowance: async () => {
      calls.allowance++;
      return s.allowance;
    },
    execute: async (id, amt) => {
      calls.execute++;
      return s.exec(id, amt);
    },
    log: () => {},
  };
  return { deps, calls, s, records, setNow: (d: Date) => (now = d), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

test("fires once on the right day and never again that day", async () => {
  const h = harness([rec()]);
  const r1 = await processAutomation(h.records[0], h.deps);
  assert.deepEqual(r1, { acted: true, result: "success" });
  assert.equal(h.calls.execute, 1);
  assert.equal(h.records[0].run?.state, "done");
  assert.equal(h.records[0].lastExecution?.status, "success");

  for (let i = 0; i < 5; i++) {
    h.advance(60_000);
    const again = await processAutomation(h.records[0], h.deps);
    assert.equal(again.acted, false);
  }
  assert.equal(h.calls.execute, 1, "must not send twice in one day");
});

test("runs again the following week", async () => {
  const h = harness([rec()]);
  await processAutomation(h.records[0], h.deps);
  h.setNow(NEXT_FRI);
  const r = await processAutomation(h.records[0], h.deps);
  assert.deepEqual(r, { acted: true, result: "success" });
  assert.equal(h.calls.execute, 2);
});

test("wrong day: no send and no network calls at all", async () => {
  const h = harness([rec()], THU);
  const r = await processAutomation(h.records[0], h.deps);
  assert.equal(r.acted, false);
  assert.equal(h.calls.execute, 0);
  assert.equal(h.calls.balance + h.calls.allowance, 0, "should not hit the RPC on off-days");
});

test("timezone: same instant fires for Lagos but not New York", async () => {
  const t = new Date("2026-10-02T02:00:00Z");
  const lagos = harness([rec({ timezone: "Africa/Lagos" })], t);
  assert.equal((await processAutomation(lagos.records[0], lagos.deps)).acted, true);
  const ny = harness([rec({ timezone: "America/New_York" })], t);
  assert.equal((await processAutomation(ny.records[0], ny.deps)).acted, false);
});

test("condition not met: no send, nothing persisted, and it fires later the same day once met", async () => {
  const h = harness([rec()]);
  h.s.balance = 50n * USDC;
  const r = await processAutomation(h.records[0], h.deps);
  assert.equal(r.acted, false);
  assert.equal(h.records[0].run, undefined, "a skipped check must not consume the day");

  h.advance(3 * 3600_000);
  h.s.balance = 300n * USDC;
  const r2 = await processAutomation(h.records[0], h.deps);
  assert.deepEqual(r2, { acted: true, result: "success" });
  assert.equal(h.calls.execute, 1);
});

test("balance below send amount or allowance too low: no send", async () => {
  const a = harness([rec({ condition: { operator: ">", thresholdBaseUnits: "0" } })]);
  a.s.balance = 5n * USDC;
  assert.equal((await processAutomation(a.records[0], a.deps)).acted, false);
  const b = harness([rec()]);
  b.s.allowance = 5n * USDC;
  assert.equal((await processAutomation(b.records[0], b.deps)).acted, false);
  assert.equal(a.calls.execute + b.calls.execute, 0);
});

test("RPC read failure: no send, nothing persisted, retried next poll", async () => {
  const h = harness([rec()]);
  h.s.balanceThrows = true;
  const r = await processAutomation(h.records[0], h.deps);
  assert.equal(r.acted, false);
  assert.equal(h.calls.execute, 0);
  assert.equal(h.records[0].run, undefined);
  h.s.balanceThrows = false;
  assert.equal((await processAutomation(h.records[0], h.deps)).acted, true);
});

test("intent is persisted BEFORE the send (at-most-once)", async () => {
  const h = harness([rec()]);
  let stateAtSend: string | undefined;
  h.s.exec = async () => {
    stateAtSend = h.records[0].run?.state;
    return ok(0n, 0n);
  };
  await processAutomation(h.records[0], h.deps);
  assert.equal(stateAtSend, "sending");
});

test("simulated crash mid-send: leftover 'sending' state prevents an automatic resend", async () => {
  const r = rec({ run: { date: "2026-10-02", state: "sending", attempts: 1 } });
  const h = harness([r]);
  const out = await processAutomation(h.records[0], h.deps);
  assert.equal(out.acted, false);
  assert.equal(h.calls.execute, 0);
  // ...but the next scheduled day proceeds normally
  h.setNow(NEXT_FRI);
  assert.equal((await processAutomation(h.records[0], h.deps)).acted, true);
});

test("contract rejection is final for the day and surfaces the on-chain reason", async () => {
  const h = harness([rec()]);
  h.s.exec = async () => ({
    hash: "0xdef",
    outcome: { status: "rejected", reason: "Amount exceeds weekly spending limit" },
  });
  const r = await processAutomation(h.records[0], h.deps);
  assert.deepEqual(r, { acted: true, result: "rejected" });
  assert.equal(h.records[0].lastExecution?.status, "rejected");
  assert.equal(h.records[0].lastExecution?.reason, "Amount exceeds weekly spending limit");
  h.advance(RETRY_BACKOFF_MS * 2);
  assert.equal((await processAutomation(h.records[0], h.deps)).acted, false);
  assert.equal(h.calls.execute, 1);
});

test("nothing-was-sent failure: retries after backoff, gives up after the daily cap, recovers next week", async () => {
  const h = harness([rec()]);
  h.s.exec = async () => {
    throw new Error("execution reverted: ERC20InsufficientAllowance");
  };

  assert.deepEqual(await processAutomation(h.records[0], h.deps), { acted: true, result: "retry" });
  assert.equal(h.records[0].run?.attempts, 1);

  // inside the backoff window: nothing happens
  h.advance(RETRY_BACKOFF_MS - 1000);
  assert.equal((await processAutomation(h.records[0], h.deps)).acted, false);
  assert.equal(h.calls.execute, 1);

  for (let i = 2; i <= MAX_ATTEMPTS_PER_DAY; i++) {
    h.advance(RETRY_BACKOFF_MS);
    assert.equal((await processAutomation(h.records[0], h.deps)).acted, true);
    assert.equal(h.records[0].run?.attempts, i);
  }
  assert.equal(h.calls.execute, MAX_ATTEMPTS_PER_DAY);

  h.advance(RETRY_BACKOFF_MS * 10);
  const stopped = await processAutomation(h.records[0], h.deps);
  assert.equal(stopped.acted, false);
  assert.match((stopped as any).reason, /gave up/);
  assert.equal(h.calls.execute, MAX_ATTEMPTS_PER_DAY, "must stop hammering");

  h.s.exec = ok;
  h.setNow(NEXT_FRI);
  assert.deepEqual(await processAutomation(h.records[0], h.deps), { acted: true, result: "success" });
  assert.equal(h.records[0].run?.attempts, 1, "attempt counter resets for a new day");
});

test("sent-but-unconfirmed: never resends that day and records the tx hash", async () => {
  const h = harness([rec()]);
  h.s.exec = async () => {
    throw new ExecutionUncertainError("0xfeed", new Error("timeout"));
  };
  const r = await processAutomation(h.records[0], h.deps);
  assert.deepEqual(r, { acted: true, result: "uncertain" });
  assert.equal(h.records[0].run?.state, "sending");
  assert.equal(h.records[0].lastExecution?.txHash, "0xfeed");

  h.advance(RETRY_BACKOFF_MS * 20);
  assert.equal((await processAutomation(h.records[0], h.deps)).acted, false);
  assert.equal(h.calls.execute, 1);
});

test("mined-and-reverted is retryable (no funds moved)", async () => {
  const h = harness([rec()]);
  h.s.exec = async () => ({ hash: "0x1", outcome: { status: "reverted" } });
  assert.deepEqual(await processAutomation(h.records[0], h.deps), { acted: true, result: "retry" });
  assert.equal(h.records[0].run?.state, "retry");
});

test("unknown outcome is treated as done, not retried (avoid a possible double send)", async () => {
  const h = harness([rec()]);
  h.s.exec = async () => ({ hash: "0x2", outcome: { status: "unknown" } });
  assert.deepEqual(await processAutomation(h.records[0], h.deps), { acted: true, result: "done-unknown" });
  h.advance(RETRY_BACKOFF_MS * 2);
  assert.equal((await processAutomation(h.records[0], h.deps)).acted, false);
  assert.equal(h.calls.execute, 1);
});

test("expired automation never sends", async () => {
  const h = harness([rec({ expiresAt: Math.floor(FRI.getTime() / 1000) - 1 })]);
  assert.equal((await processAutomation(h.records[0], h.deps)).acted, false);
  assert.equal(h.calls.execute, 0);
});

test("legacy record without schedule data is skipped safely", async () => {
  const legacy = { id: "old", onchainId: "1", userId: "demo", status: "active" } as unknown as AutomationRecord;
  const h = harness([legacy]);
  const r = await processAutomation(legacy, h.deps);
  assert.equal(r.acted, false);
  assert.equal(h.calls.execute, 0);
});

test("pollOnce: only active automations run, and one failure doesn't block the others", async () => {
  const a = rec({ id: "a", onchainId: "0" });
  const paused = rec({ id: "b", onchainId: "1", status: "paused" });
  const c = rec({ id: "c", onchainId: "2" });
  const h = harness([a, paused, c]);
  const origUpdate = h.deps.update;
  h.deps.update = async (id, fn) => {
    if (id === "a") throw new Error("disk full");
    return origUpdate(id, fn);
  };
  await pollOnce(h.deps);
  assert.equal(h.calls.execute, 1, "c ran; a failed before sending; b is paused");
  assert.equal(h.records[2].lastExecution?.status, "success");
  assert.equal(h.records[1].lastExecution, undefined);
});

// ------------------------------------------------------------------ poll interval
test("parsePollInterval: a blank value (as copied from .env.example) falls back to the default, never 0", () => {
  assert.equal(parsePollInterval(""), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(parsePollInterval("   "), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(parsePollInterval(undefined), DEFAULT_POLL_INTERVAL_MS);
});

test("parsePollInterval: junk, zero, negative and too-small values fall back to the default", () => {
  for (const bad of ["abc", "0", "-5", "999", "NaN", "Infinity"]) {
    assert.equal(parsePollInterval(bad), DEFAULT_POLL_INTERVAL_MS, bad);
  }
});

test("parsePollInterval: a sensible value is used as given", () => {
  assert.equal(parsePollInterval("1000"), 1000);
  assert.equal(parsePollInterval("5000"), 5000);
  assert.equal(parsePollInterval("300000"), 300000);
});
