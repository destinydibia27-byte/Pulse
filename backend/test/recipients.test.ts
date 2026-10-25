import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeLabel, checkRecipientAddress } from "../src/recipients";
import { allow, callerKey, resetRateLimits } from "../src/rateLimit";
import {
  buildRecipientSetMessage, buildRecipientRemoveMessage, verifyAuth,
} from "../src/auth";
import {
  getRecipients, setRecipient, removeRecipient, saveAutomation, getAutomationById, storageBackend,
  type AutomationRecord,
} from "../src/db";

const NOW = 1_800_000_000_000;
const A = "0x01aD5f069a436f67fDCED12babE12CD9e2C19BB1";
const B = "0x048d453f8fA81ef9CE18f66Dd88ACEC202796a81";

// ------------------------------------------------------------------ labels and addresses
test("labels: normalised to lower case with single spaces; junk is refused", () => {
  assert.equal(normalizeLabel("  Savings "), "savings");
  assert.equal(normalizeLabel("My   Mum"), "my mum");
  assert.equal(normalizeLabel("rent_2"), "rent_2");
  for (const bad of ["", " ", "a".repeat(33), "-start", "has<script>", "émoji😀", 5, null, undefined]) {
    assert.equal(normalizeLabel(bad), null, `should refuse ${String(bad)}`);
  }
});

test("labels: line breaks and tabs are collapsed to a space, so a label can never smuggle a new line into a signed message", () => {
  assert.equal(normalizeLabel("line\nbreak"), "line break");
  assert.equal(normalizeLabel("a\r\n\tb"), "a b");
  assert.ok(!/[\r\n\t]/.test(normalizeLabel("x\ny\tz")!));
});

test("addresses: lower-case and correct checksum pass; bad checksum, garbage and zero are refused", () => {
  assert.deepEqual(checkRecipientAddress(A), { ok: true, address: A });
  assert.deepEqual(checkRecipientAddress(A.toLowerCase()), { ok: true, address: A });
  const wrongCase = A.slice(0, 12) + A.slice(12).replace(/[a-f]/, (c) => c.toUpperCase()); // flips one letter's case
  const r = checkRecipientAddress(wrongCase);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /checksum/);
  assert.equal(checkRecipientAddress("0x123").ok, false);
  assert.equal(checkRecipientAddress("not an address").ok, false);
  assert.equal(checkRecipientAddress(42).ok, false);
  assert.match((checkRecipientAddress("0x0000000000000000000000000000000000000000") as any).reason, /zero address/);
});

test("addresses: forbidden addresses are refused with their own reason, in any letter case", () => {
  const r = checkRecipientAddress(B.toLowerCase(), [{ address: B, why: "That is the USDC token contract." }]);
  assert.deepEqual(r, { ok: false, reason: "That is the USDC token contract." });
});

// ------------------------------------------------------------------ signed recipient messages
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

test("recipient messages: a signature for one label/address does not verify for another", async () => {
  const msg = buildRecipientSetMessage(owner.address, "savings", A, NOW);
  const sig = await owner.signMessage({ message: msg });
  assert.equal((await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW)).ok, true);
  for (const other of [
    buildRecipientSetMessage(owner.address, "savings", B, NOW),       // different address
    buildRecipientSetMessage(owner.address, "rent", A, NOW),          // different label
    buildRecipientSetMessage(A, "savings", A, NOW),                   // different owner
    buildRecipientRemoveMessage(owner.address, "savings", NOW),       // different action
  ]) {
    assert.equal((await verifyAuth({ message: other, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW)).ok, false);
  }
});

// ------------------------------------------------------------------ rate limiter
beforeEach(() => resetRateLimits());

test("rate limit: allows up to the limit per caller, then refuses, then recovers after the window", () => {
  const lim = { perCaller: 3, global: 100, windowMs: 1000 };
  assert.deepEqual([1, 2, 3, 4].map(() => allow("r", "ip1", lim, NOW)), [true, true, true, false]);
  assert.equal(allow("r", "ip2", lim, NOW), true, "another caller is unaffected");
  assert.equal(allow("r", "ip1", lim, NOW + 1001), true, "a new window starts fresh");
});

test("rate limit: the global ceiling holds even when every request comes from a new caller", () => {
  const lim = { perCaller: 5, global: 4, windowMs: 1000 };
  const results = Array.from({ length: 6 }, (_, i) => allow("g", `spoofed-${i}`, lim, NOW));
  assert.deepEqual(results, [true, true, true, true, false, false]);
});

test("rate limit: routes are counted separately", () => {
  const lim = { perCaller: 1, global: 10, windowMs: 1000 };
  assert.equal(allow("a", "ip", lim, NOW), true);
  assert.equal(allow("b", "ip", lim, NOW), true);
  assert.equal(allow("a", "ip", lim, NOW), false);
});

test("callerKey: first forwarded address, then x-real-ip, then unknown", () => {
  const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });
  assert.equal(callerKey(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(callerKey(h({ "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(callerKey(h({})), "unknown");
});

// ------------------------------------------------------------------ per-user recipient storage (JSON file mode)
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volo-rec-"));
  process.env.PULSE_DB_PATH = path.join(dir, "automations.json");
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test("recipients (file): each user has their own book; one user's label never resolves for another", async () => {
  assert.equal(storageBackend(), "file");
  await setRecipient("0xuser1", "savings", A);
  await setRecipient("0xuser2", "savings", B);
  await setRecipient("0xuser1", "rent", B);
  assert.deepEqual(await getRecipients("0xuser1"), { savings: A, rent: B });
  assert.deepEqual(await getRecipients("0xuser2"), { savings: B });
  assert.deepEqual(await getRecipients("0xnobody"), {});
});

test("recipients (file): saving the same label again replaces it; removing deletes only that label", async () => {
  await setRecipient("u", "savings", A);
  await setRecipient("u", "savings", B);
  assert.deepEqual(await getRecipients("u"), { savings: B });
  await setRecipient("u", "rent", A);
  await removeRecipient("u", "savings");
  assert.deepEqual(await getRecipients("u"), { rent: A });
  await removeRecipient("u", "does-not-exist"); // no error
});

test("getAutomationById finds a record by id and returns undefined for an unknown id", async () => {
  const rec = { id: "0xabc-7", onchainId: "7", userId: "0xabc", status: "active" } as unknown as AutomationRecord;
  await saveAutomation(rec);
  assert.equal((await getAutomationById("0xabc-7"))?.onchainId, "7");
  assert.equal(await getAutomationById("nope"), undefined);
});
