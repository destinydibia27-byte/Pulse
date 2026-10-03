/**
 * Drives the REAL backend chain.ts against a local Anvil deployment.
 * Run via contracts/script/local-e2e.sh (it deploys everything and sets env).
 * Asserts on outcomes read from on-chain events, not on "tx mined".
 */
import { attemptExecution, readPermission } from "../src/chain";
import assert from "node:assert/strict";

async function afterCancel() {
  const r = await attemptExecution(0n, 1n);
  console.log("exec after cancel ->", r.outcome);
  assert.equal(r.outcome.status, "rejected");
  assert.equal((r.outcome as any).reason, "Permission cancelled");
  console.log("E2E-PART-2 OK (cancel is enforced on-chain)");
}

const NEVER = 2n ** 256n - 1n; // lastExecutionDay sentinel: no successful send yet

async function main() {
  if (process.argv[2] === "after-cancel") return afterCancel();
  const amount = 10_000_000n; // 10 USDC (6 decimals)

  // id 0: today (UTC), condition met -> sends.
  const first = await attemptExecution(0n, amount);
  console.log("#0 first run ->", first.outcome);
  assert.equal(first.outcome.status, "success");

  // Same UTC day again: the CONTRACT refuses a second send, whatever the amount or caps.
  const second = await attemptExecution(0n, 1n);
  console.log("#0 second run same day ->", second.outcome);
  assert.equal(second.outcome.status, "rejected");
  assert.equal((second.outcome as any).reason, "Already executed for this UTC day");
  // Key point: the rejection tx was MINED successfully.
  assert.equal(second.receipt.status, "success");

  // id 1: right day, but the balance condition (> 5000 USDC) is not met.
  const unmet = await attemptExecution(1n, 1n);
  console.log("#1 condition unmet ->", unmet.outcome);
  assert.equal(unmet.outcome.status, "rejected");
  assert.equal((unmet.outcome as any).reason, "Balance condition not met");

  // id 2: scheduled for a different weekday, so even a perfectly valid send is refused.
  const wrongDay = await attemptExecution(2n, 1n);
  console.log("#2 wrong weekday ->", wrongDay.outcome);
  assert.equal(wrongDay.outcome.status, "rejected");
  assert.equal((wrongDay.outcome as any).reason, "Not the scheduled day (UTC)");

  // id 3: right day, condition met, but over the per-execution cap.
  const over = await attemptExecution(3n, amount + 1n);
  console.log("#3 over cap ->", over.outcome);
  assert.equal(over.outcome.status, "rejected");
  assert.equal((over.outcome as any).reason, "Amount exceeds per-execution limit");

  // Accounting: only #0 moved money and used up its day; rejections consume nothing.
  const p0: any = await readPermission(0n);
  console.log("#0 spentInWindow:", p0[8], "lastExecutionDay:", p0[13]);
  assert.equal(p0[8], amount);
  assert.notEqual(p0[13], NEVER, "a successful send records the UTC day");
  for (const id of [1n, 2n, 3n]) {
    const p: any = await readPermission(id);
    assert.equal(p[8], 0n, `#${id} spent nothing`);
    assert.equal(p[13], NEVER, `#${id}: a rejection must not burn the day`);
  }

  console.log("E2E-PART-1 OK");
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
