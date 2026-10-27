import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAutomation, recordExecutionResult, listAutomationsForUser, HISTORY_LIMIT, type AutomationRecord } from "../src/db";

const record = (): AutomationRecord => ({
  id: "demo-0", onchainId: "0", userId: "demo", label: "Test", recipientLabel: "savings",
  amountBaseUnits: "1000000", owner: "0x01aD5f069a436f67fDCED12babE12CD9e2C19BB1",
  asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  trigger: { day: "friday" }, condition: { operator: ">", thresholdBaseUnits: "1000000" },
  timezone: "UTC", expiresAt: 1_900_000_000, status: "active", createdAt: new Date().toISOString(),
});

const get = async () => (await listAutomationsForUser("demo"))[0];

beforeEach(async () => {
  process.env.PULSE_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "volo-db-")), "automations.json");
  await saveAutomation(record());
});

test("a record without history stays valid (older data)", async () => {
  const r = await get();
  assert.equal(r.history, undefined);
  assert.equal(r.lastExecution, undefined);
});

test("every result is kept in order and lastExecution is the newest", async () => {
  await recordExecutionResult("demo-0", { status: "rejected", reason: "Already executed for this UTC day", txHash: "0xaaa" });
  await recordExecutionResult("demo-0", { status: "error", error: "RPC down" });
  await recordExecutionResult("demo-0", { status: "success", txHash: "0xbbb" });
  const r = await get();
  assert.deepEqual(r.history!.map((h) => h.status), ["rejected", "error", "success"]);
  assert.equal(r.lastExecution!.txHash, "0xbbb");
  assert.deepEqual(r.history![r.history!.length - 1], r.lastExecution);
});

test("a submitted transaction is replaced by its final result, not listed twice", async () => {
  await recordExecutionResult("demo-0", { status: "submitted", txHash: "0xabc" });
  await recordExecutionResult("demo-0", { status: "success", txHash: "0xabc" });
  const r = await get();
  assert.equal(r.history!.length, 1);
  assert.equal(r.history![0].status, "success");
});

test("different transactions are separate entries, even right after each other", async () => {
  await recordExecutionResult("demo-0", { status: "success", txHash: "0x111" });
  await recordExecutionResult("demo-0", { status: "success", txHash: "0x222" });
  assert.equal((await get()).history!.length, 2);
});

test("entries without a transaction never collapse into each other", async () => {
  await recordExecutionResult("demo-0", { status: "error", error: "a" });
  await recordExecutionResult("demo-0", { status: "error", error: "b" });
  assert.equal((await get()).history!.length, 2);
});

test("history is capped at the newest HISTORY_LIMIT entries", async () => {
  for (let i = 0; i < HISTORY_LIMIT + 7; i++) {
    await recordExecutionResult("demo-0", { status: "error", error: `e${i}` });
  }
  const h = (await get()).history!;
  assert.equal(h.length, HISTORY_LIMIT);
  assert.equal(h[0].error, "e7", "the oldest entries are dropped");
  assert.equal(h[h.length - 1].error, `e${HISTORY_LIMIT + 6}`);
});

test("recording for an unknown automation changes nothing and does not throw", async () => {
  await recordExecutionResult("nope", { status: "success", txHash: "0x1" });
  assert.equal((await get()).history, undefined);
});
