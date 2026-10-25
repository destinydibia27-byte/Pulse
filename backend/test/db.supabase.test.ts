import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  saveAutomation, updateAutomation, recordExecutionResult, setStatus,
  listActiveAutomations, listAutomationsForUser, storageBackend, type AutomationRecord,
  getRecipients, setRecipient, removeRecipient, getAutomationById,
} from "../src/db";

/**
 * These tests run the real db.ts against a small in-process stand-in for Supabase's REST API (PostgREST).
 * The stand-in implements only what db.ts uses: GET with eq. filters, POST insert (409 on a duplicate id),
 * and PATCH with eq. filters returning the changed rows. It proves db.ts's own logic (version checks,
 * retries, filters, headers, error handling). It does NOT prove that a real Supabase project is set up
 * correctly: that is checked by /api/health on the deployed app.
 */
const KEY = "sb_secret_test_key_000000";

interface Stored { id: string; user_id: string; status: string; version: number; data: any; created_at: string; updated_at: string }
let rows: Map<string, Stored>;
let recipientRows: Map<string, { user_id: string; label: string; address: string; updated_at?: string }>;
let seenHeaders: http.IncomingHttpHeaders[];
let beforePatch: (() => void) | null;
let failNext: { status: number; body: string } | null;
let server: http.Server;
let nextCreated = 0;

function applyFilters(list: Stored[], params: URLSearchParams): Stored[] {
  let out = list;
  for (const [k, v] of params) {
    if (!v.startsWith("eq.")) continue;
    const want = v.slice(3);
    out = out.filter((r) => String((r as any)[k]) === want);
  }
  return out;
}

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  seenHeaders.push(req.headers);
  const url = new URL(req.url!, "http://x");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  if (req.headers.apikey !== KEY) return send(401, { message: "Invalid API key" });
  const isRecipients = url.pathname === "/rest/v1/volo_recipients";
  if (url.pathname !== "/rest/v1/volo_automations" && !isRecipients) return send(404, { message: "no such table" });
  if (failNext) { const f = failNext; failNext = null; return send(f.status, f.body); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    if (isRecipients) {
      const key = (r: { user_id: string; label: string }) => `${r.user_id}\u0000${r.label}`;
      if (req.method === "GET") {
        return send(200, applyFilters([...recipientRows.values()] as any, url.searchParams));
      }
      if (req.method === "POST") {
        // Upsert: only valid with the on_conflict target and the merge-duplicates preference.
        if (url.searchParams.get("on_conflict") !== "user_id,label" || !String(req.headers.prefer).includes("resolution=merge-duplicates")) {
          return send(409, { code: "23505", message: "duplicate key value" });
        }
        recipientRows.set(key(body), body);
        return send(201, undefined);
      }
      if (req.method === "DELETE") {
        for (const r of applyFilters([...recipientRows.values()] as any, url.searchParams)) recipientRows.delete(key(r as any));
        return send(204, undefined);
      }
      return send(405, {});
    }
    if (req.method === "GET") {
      const list = applyFilters([...rows.values()], url.searchParams).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return send(200, list);
    }
    if (req.method === "POST") {
      if (rows.has(body.id)) return send(409, { code: "23505", message: "duplicate key value" });
      const now = String(1000 + nextCreated++).padStart(8, "0");
      rows.set(body.id, { ...body, created_at: now, updated_at: now });
      return send(201, undefined);
    }
    if (req.method === "PATCH") {
      if (beforePatch) { const f = beforePatch; beforePatch = null; f(); }
      const hit = applyFilters([...rows.values()], url.searchParams);
      for (const r of hit) Object.assign(r, body);
      return send(200, hit);
    }
    return send(405, {});
  });
}

const record = (over: Partial<AutomationRecord> = {}): AutomationRecord => ({
  id: "demo-0", onchainId: "0", userId: "demo", label: "Test", recipientLabel: "savings",
  amountBaseUnits: "1000000", owner: "0x01aD5f069a436f67fDCED12babE12CD9e2C19BB1",
  asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  trigger: { day: "friday" }, condition: { operator: ">", thresholdBaseUnits: "1000000" },
  timezone: "UTC", expiresAt: 1_900_000_000, status: "active", createdAt: new Date().toISOString(), ...over,
});

beforeEach(async () => {
  rows = new Map(); recipientRows = new Map(); seenHeaders = []; beforePatch = null; failNext = null; nextCreated = 0;
  server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`; // trailing slash on purpose
  process.env.SUPABASE_SECRET_KEY = KEY;
});
afterEach(async () => { await new Promise((r) => server.close(r)); });
after(() => { delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY; });

test("supabase: the backend is chosen only when both variables are set, and a half setup is an error", () => {
  assert.equal(storageBackend(), "supabase");
  delete process.env.SUPABASE_SECRET_KEY;
  assert.throws(() => storageBackend(), /half-configured/);
  delete process.env.SUPABASE_URL;
  assert.equal(storageBackend(), "file");
});

test("supabase: save then list by user and by active status", async () => {
  await saveAutomation(record({ id: "demo-0" }));
  await saveAutomation(record({ id: "demo-1", status: "paused" }));
  await saveAutomation(record({ id: "other-0", userId: "other" }));
  assert.deepEqual((await listAutomationsForUser("demo")).map((a) => a.id), ["demo-0", "demo-1"]);
  assert.deepEqual((await listActiveAutomations()).map((a) => a.id).sort(), ["demo-0", "other-0"]);
});

test("supabase: saving an existing id replaces it and keeps the filter columns in sync", async () => {
  await saveAutomation(record());
  await saveAutomation(record({ label: "Renamed", status: "cancelled" }));
  assert.equal(rows.size, 1);
  assert.equal(rows.get("demo-0")!.version, 2);
  assert.equal(rows.get("demo-0")!.status, "cancelled");
  assert.equal((await listAutomationsForUser("demo"))[0].label, "Renamed");
  assert.deepEqual(await listActiveAutomations(), []);
});

test("supabase: update changes the record and the status column, and an unknown id returns undefined", async () => {
  await saveAutomation(record());
  await setStatus("demo-0", "paused");
  assert.equal(rows.get("demo-0")!.status, "paused");
  assert.deepEqual(await listActiveAutomations(), []);
  assert.equal(await updateAutomation("nope", () => { throw new Error("must not run"); }), undefined);
});

test("supabase: a write that loses a race re-reads and re-applies on the fresh copy (no lost update)", async () => {
  await saveAutomation(record());
  let calls = 0;
  // After our read but before our write, "another process" changes the row.
  beforePatch = () => { const r = rows.get("demo-0")!; r.data = { ...r.data, label: "changed elsewhere" }; r.version += 1; };
  await updateAutomation("demo-0", (rec) => { calls++; rec.amountBaseUnits = "2000000"; });
  assert.equal(calls, 2, "the change function must run again on the fresh data");
  const final = rows.get("demo-0")!.data;
  assert.equal(final.label, "changed elsewhere", "the other writer's change survives");
  assert.equal(final.amountBaseUnits, "2000000", "our change is applied too");
});

test("supabase: concurrent result recordings are all kept", async () => {
  await saveAutomation(record());
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => recordExecutionResult("demo-0", { status: "error", error: `e${i}` }))
  );
  const history = rows.get("demo-0")!.data.history as any[];
  assert.equal(history.length, 8);
  assert.deepEqual(history.map((h) => h.error).sort(), Array.from({ length: 8 }, (_, i) => `e${i}`).sort());
});

test("supabase: a submitted transaction is still replaced by its final result", async () => {
  await saveAutomation(record());
  await recordExecutionResult("demo-0", { status: "submitted", txHash: "0xabc" });
  await recordExecutionResult("demo-0", { status: "success", txHash: "0xabc" });
  const h = rows.get("demo-0")!.data.history as any[];
  assert.equal(h.length, 1);
  assert.equal(h[0].status, "success");
});

test("supabase: a failing request throws loudly with the status, and never includes the key", async () => {
  failNext = { status: 503, body: "upstream unavailable" };
  await assert.rejects(() => listAutomationsForUser("demo"), (e: Error) => {
    assert.match(e.message, /HTTP 503/);
    assert.match(e.message, /upstream unavailable/);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test("supabase: a wrong key is rejected by the server and surfaces as an error", async () => {
  process.env.SUPABASE_SECRET_KEY = "sb_secret_wrong";
  await assert.rejects(() => listActiveAutomations(), /HTTP 401/);
});

test("supabase: key header rules (new-style key in apikey only; legacy JWT also as bearer)", async () => {
  await listActiveAutomations();
  assert.equal(seenHeaders.at(-1)!.apikey, KEY);
  assert.equal(seenHeaders.at(-1)!.authorization, undefined);
  const legacy = "eyJhbGciOiJIUzI1NiJ9.legacy.jwt";
  process.env.SUPABASE_SECRET_KEY = legacy;
  await assert.rejects(() => listActiveAutomations(), /HTTP 401/); // stand-in only knows KEY, but we can still inspect what was sent
  assert.equal(seenHeaders.at(-1)!.apikey, legacy);
  assert.equal(seenHeaders.at(-1)!.authorization, `Bearer ${legacy}`);
});

test("supabase: ids with special characters are encoded in the filter", async () => {
  await saveAutomation(record({ id: "a b&c=d,e" }));
  assert.equal((await updateAutomation("a b&c=d,e", (r) => { r.label = "ok"; }))!.label, "ok");
});

test("supabase: recipients are stored per user, replaced on re-save, and removed by label", async () => {
  const A = "0x01aD5f069a436f67fDCED12babE12CD9e2C19BB1";
  const B = "0x048d453f8fA81ef9CE18f66Dd88ACEC202796a81";
  await setRecipient("u1", "savings", A);
  await setRecipient("u2", "savings", B);
  await setRecipient("u1", "rent", B);
  assert.deepEqual(await getRecipients("u1"), { rent: B, savings: A });
  assert.deepEqual(await getRecipients("u2"), { savings: B });
  await setRecipient("u1", "savings", B);                       // replace, no duplicate row
  assert.equal(recipientRows.size, 3);
  assert.equal((await getRecipients("u1")).savings, B);
  await removeRecipient("u1", "savings");
  assert.deepEqual(await getRecipients("u1"), { rent: B });
  assert.deepEqual(await getRecipients("u2"), { savings: B }, "another user's book is untouched");
});

test("supabase: a user id or label with special characters stays inside its own filter", async () => {
  const A = "0x01aD5f069a436f67fDCED12babE12CD9e2C19BB1";
  await setRecipient("u1&user_id=neq.zzz", "a b", A);
  await setRecipient("u1", "a b", A);
  assert.deepEqual(Object.keys(await getRecipients("u1")), ["a b"]);
  assert.equal(Object.keys(await getRecipients("u1&user_id=neq.zzz")).length, 1);
});

test("supabase: getAutomationById returns the record, or undefined", async () => {
  await saveAutomation(record({ id: "0xabc-3" }));
  assert.equal((await getAutomationById("0xabc-3"))?.id, "0xabc-3");
  assert.equal(await getAutomationById("missing"), undefined);
});
