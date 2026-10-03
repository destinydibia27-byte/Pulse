import { promises as fs } from "fs";
import path from "path";
import type { Operator, RunState, Weekday } from "./scheduler";

/**
 * Deliberately minimal JSON-file store for the hackathon MVP. NEVER add a field
 * for private keys or seed phrases: custody lives in the user's wallet and the
 * executor's own key, never here.
 *
 * The worker and the web app are separate processes and MUST point at the same
 * file. Set PULSE_DB_PATH for both. The default is <repo>/data/automations.json
 * resolved from the process working directory (../data from backend/ or frontend/).
 *
 * Limits: writes are atomic (temp file + rename) and serialized within one process,
 * but two processes doing read-modify-write can still lose an update. Fine for one
 * worker + a demo UI; use SQLite/Postgres before anything real.
 */

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
  lastExecution?: {
    status: "submitted" | "success" | "rejected" | "error";
    txHash?: string;
    reason?: string;
    error?: string;
    at: string;
  };
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

export const listActiveAutomations = () =>
  locked(async () => (await readAll()).filter((a) => a.status === "active"));

export const listAutomationsForUser = (userId: string) =>
  locked(async () => (await readAll()).filter((a) => a.userId === userId));

export const saveAutomation = (record: AutomationRecord) =>
  locked(async () => {
    const all = await readAll();
    const idx = all.findIndex((a) => a.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    await writeAll(all);
  });

/** Read-modify-write one record in a single locked step. */
export const updateAutomation = (id: string, fn: (record: AutomationRecord) => void) =>
  locked(async () => {
    const all = await readAll();
    const record = all.find((a) => a.id === id);
    if (!record) return undefined;
    fn(record);
    await writeAll(all);
    return record;
  });

export const recordExecutionResult = (
  id: string,
  result: Omit<NonNullable<AutomationRecord["lastExecution"]>, "at">
) =>
  updateAutomation(id, (r) => {
    r.lastExecution = { ...result, at: new Date().toISOString() };
  }).then(() => undefined);

export const setStatus = (id: string, status: AutomationRecord["status"]) =>
  updateAutomation(id, (r) => {
    r.status = status;
  }).then(() => undefined);
