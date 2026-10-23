import { promises as fs } from "fs";
import path from "path";
import type { Operator, RunState, Weekday } from "./scheduler";

/**
 * Deliberately minimal store for the hackathon MVP. NEVER add a field for private keys or seed
 * phrases: custody lives in the user's wallet and the executor's own key, never here.
 *
 * Two backends, chosen by environment:
 *
 *  1. Supabase (Postgres over HTTPS) when BOTH SUPABASE_URL and SUPABASE_SECRET_KEY are set.
 *     Use this on a host with no persistent disk (for example a free Render web service). One row
 *     per automation. Writes are optimistic: an update reads the row and its version, then writes
 *     only if the version is unchanged, and retries on a conflict. That also closes the lost-update
 *     gap between the worker and the web app. The secret key bypasses row-level security, so it
 *     must live only in server-side environment variables, never in a NEXT_PUBLIC_ one.
 *     Table definition: supabase/schema.sql. If only one of the two variables is set, that is an
 *     error, never a silent fallback to the file.
 *  2. A JSON file otherwise. The worker and the web app are separate processes and MUST point at
 *     the same file. Set PULSE_DB_PATH for both. The default is <repo>/data/automations.json
 *     resolved from the process working directory (../data from backend/ or frontend/).
 *     Limits: writes are atomic (temp file + rename) and serialized within one process, but two
 *     processes doing read-modify-write can still lose an update. Fine for one worker + a demo UI.
 */

/** One recorded result of an attempt to run an automation. */
export interface ExecutionEntry {
  status: "submitted" | "success" | "rejected" | "error";
  txHash?: string;
  reason?: string;
  error?: string;
  at: string;
}

/** Newest results kept per automation. The JSON store is not an archive; the chain is. */
export const HISTORY_LIMIT = 50;

export interface AutomationRecord {
  id: string;
  onchainId: string;
  userId: string;
  label: string;
  recipientLabel: string;
  amountBaseUnits: string; // what each run sends
  owner: `0x${string}`; // wallet that owns the on-chain permission
  asset: `0x${string}`;
  trigger: { day: Weekday };
  condition: { operator: Operator; thresholdBaseUnits: string };
  timezone: string; // IANA zone the schedule is read in. Registration always sets "UTC" to match the contract's on-chain weekday
  expiresAt: number; // unix seconds, mirrors the on-chain expiry
  status: "active" | "paused" | "cancelled" | "expired";
  createdAt: string;
  run?: RunState;
  lastExecution?: ExecutionEntry;
  /** Oldest first, capped at HISTORY_LIMIT. Absent on records that predate it. */
  history?: ExecutionEntry[];
}

function dbPath(): string {
  return process.env.PULSE_DB_PATH
    ? path.resolve(process.env.PULSE_DB_PATH)
    : path.resolve(process.cwd(), "..", "data", "automations.json");
}

// Serialize operations within this process so concurrent API calls can't interleave.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<AutomationRecord[]> {
  try {
    return JSON.parse(await fs.readFile(dbPath(), "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err; // corrupt JSON must be loud, never silently treated as "empty"
  }
}

async function writeAll(records: AutomationRecord[]): Promise<void> {
  const file = dbPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2));
  await fs.rename(tmp, file); // atomic replace: readers never see a half-written file
}

// ------------------------------------------------------------------ Supabase backend

const TABLE = "volo_automations";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_WRITE_ATTEMPTS = 12;

function supabaseConfig(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!url && !key) return null;
  if (!url || !key) {
    throw new Error(
      "Supabase is half-configured: set BOTH SUPABASE_URL and SUPABASE_SECRET_KEY, or neither to use the JSON file."
    );
  }
  return { url, key };
}

/** Which store is active right now. Throws if Supabase is only half-configured. */
export function storageBackend(): "supabase" | "file" {
  return supabaseConfig() ? "supabase" : "file";
}

interface Row {
  id: string;
  version: number;
  data: AutomationRecord;
}

class SupabaseError extends Error {
  constructor(public status: number, body: string) {
    super(`Supabase request failed (HTTP ${status}): ${body.slice(0, 300)}`);
  }
}

async function rest(method: "GET" | "POST" | "PATCH", query: string, body?: unknown, prefer?: string): Promise<Row[]> {
  const cfg = supabaseConfig()!;
  const headers: Record<string, string> = { apikey: cfg.key, "Content-Type": "application/json" };
  // New-style keys (sb_secret_...) go in apikey only. A legacy key is a JWT and is also sent as a bearer token.
  if (cfg.key.startsWith("eyJ")) headers.Authorization = `Bearer ${cfg.key}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${cfg.url}/rest/v1/${TABLE}${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", // Next.js must never serve a stale copy of the database
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new SupabaseError(res.status, text);
  return text ? (JSON.parse(text) as Row[]) : [];
}

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => sleep(10 * (attempt + 1) + Math.floor(Math.random() * 25));

const sbList = async (filter: string): Promise<AutomationRecord[]> =>
  (await rest("GET", `?select=id,version,data&${filter}&order=created_at.asc,id.asc`)).map((r) => r.data);

async function sbUpdate(id: string, fn: (record: AutomationRecord) => void): Promise<AutomationRecord | undefined> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const rows = await rest("GET", `?select=id,version,data&id=eq.${enc(id)}`);
    if (rows.length === 0) return undefined;
    const { version } = rows[0];
    const record = rows[0].data;
    fn(record); // always applied to a freshly read copy, so a retry never overwrites someone else's change
    const written = await rest(
      "PATCH",
      `?id=eq.${enc(id)}&version=eq.${version}`,
      { data: record, user_id: record.userId, status: record.status, version: version + 1, updated_at: new Date().toISOString() },
      "return=representation"
    );
    if (written.length > 0) return record;
    await backoff(attempt); // someone else wrote first: read again and redo
  }
  throw new Error(`Could not update automation ${id}: it kept changing under us. Try again.`);
}

async function sbSave(record: AutomationRecord): Promise<void> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const rows = await rest("GET", `?select=id,version,data&id=eq.${enc(record.id)}`);
    if (rows.length > 0) {
      const { version } = rows[0];
      const written = await rest(
        "PATCH",
        `?id=eq.${enc(record.id)}&version=eq.${version}`,
        { data: record, user_id: record.userId, status: record.status, version: version + 1, updated_at: new Date().toISOString() },
        "return=representation"
      );
      if (written.length > 0) return;
    } else {
      try {
        await rest("POST", "", { id: record.id, user_id: record.userId, status: record.status, version: 1, data: record }, "return=minimal");
        return;
      } catch (err) {
        if (!(err instanceof SupabaseError && err.status === 409)) throw err; // 409 = someone inserted it first: loop and update
      }
    }
    await backoff(attempt);
  }
  throw new Error(`Could not save automation ${record.id}: it kept changing under us. Try again.`);
}

export const listActiveAutomations = () =>
  supabaseConfig()
    ? sbList("status=eq.active")
    : locked(async () => (await readAll()).filter((a) => a.status === "active"));

export const listAutomationsForUser = (userId: string) =>
  supabaseConfig()
    ? sbList(`user_id=eq.${enc(userId)}`)
    : locked(async () => (await readAll()).filter((a) => a.userId === userId));

export const saveAutomation = (record: AutomationRecord): Promise<void> =>
  supabaseConfig() ? sbSave(record) : locked(async () => {
    const all = await readAll();
    const idx = all.findIndex((a) => a.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    await writeAll(all);
  });

/** Read-modify-write one record in a single locked step. */
export const updateAutomation = (id: string, fn: (record: AutomationRecord) => void): Promise<AutomationRecord | undefined> =>
  supabaseConfig() ? sbUpdate(id, fn) : locked(async () => {
    const all = await readAll();
    const record = all.find((a) => a.id === id);
    if (!record) return undefined;
    fn(record);
    await writeAll(all);
    return record;
  });

export const recordExecutionResult = (id: string, result: Omit<ExecutionEntry, "at">) =>
  updateAutomation(id, (r) => {
    const entry: ExecutionEntry = { ...result, at: new Date().toISOString() };
    r.lastExecution = entry;
    const history = r.history ?? [];
    const last = history[history.length - 1];
    // A transaction is first recorded as "submitted" and then finalized as success, rejected or
    // error. Replace that entry instead of listing the same transaction twice.
    if (last && entry.txHash && last.txHash === entry.txHash) history[history.length - 1] = entry;
    else history.push(entry);
    r.history = history.slice(-HISTORY_LIMIT);
  }).then(() => undefined);

export const setStatus = (id: string, status: AutomationRecord["status"]) =>
  updateAutomation(id, (r) => {
    r.status = status;
  }).then(() => undefined);
