/**
 * MVP TRIGGER WORKER: decides WHEN to ATTEMPT an automation. It is no longer what decides
 * whether the attempt is allowed.
 *
 * The contract itself enforces caps, recipient, expiry, the weekday (UTC), once-per-UTC-day,
 * and the balance condition, in execute(). A compromised or buggy worker therefore cannot
 * move funds on the wrong day, twice in a day, or when the condition is unmet: those calls
 * come back as ExecutionRejected. The worker's pre-checks below exist to avoid wasting gas
 * on attempts the chain would refuse, not to provide safety.
 *
 * What it can still do wrong (and the chain cannot prevent): fail to attempt at all. It is a
 * single process, so if it is down, "every Friday" silently does not happen. The production
 * path replaces it with a decentralized keeper network (Chainlink Automation or Gelato Web3
 * Functions). Nothing else needs to change, because execute() re-validates everything
 * on-chain no matter who calls it.
 *
 * Rules it follows (see scheduler.ts for the pure logic):
 *  - "Every <day>" = that calendar day in the automation's timezone. Registration always
 *    stores "UTC" so this matches the contract's UTC weekday exactly.
 *  - Fires the first time the balance condition holds that day, at most once per day.
 *  - AT-MOST-ONCE: intent to send is persisted BEFORE sending. If we crash, or a sent
 *    transaction is never confirmed, we do not resend automatically that day.
 *  - Failures before anything is sent are retried with backoff, max 3 per day.
 *  - Run exactly ONE worker against a given database file.
 */

import path from "path";
import type { Address } from "viem";
import {
  attemptExecution,
  executorAccountAddress,
  ExecutionUncertainError,
  getPublicClient,
  readAllowance,
  readContractExecutor,
  readTokenBalanceOf,
  type ExecutionOutcome,
} from "./chain";
import {
  listActiveAutomations,
  updateAutomation,
  type AutomationRecord,
} from "./db";
import {
  checkChainState,
  checkSchedule,
  markDone,
  markRetry,
  markSending,
} from "./scheduler";

export interface WorkerDeps {
  now(): Date;
  listActive(): Promise<AutomationRecord[]>;
  update(id: string, fn: (r: AutomationRecord) => void): Promise<unknown>;
  readBalance(owner: Address, asset: Address): Promise<bigint>;
  readAllowance(owner: Address, asset: Address): Promise<bigint>;
  execute(
    onchainId: bigint,
    amount: bigint
  ): Promise<{ hash: `0x${string}`; outcome: ExecutionOutcome }>;
  log(message: string): void;
}

export type ProcessResult =
  | { acted: false; reason: string }
  | { acted: true; result: "success" | "rejected" | "retry" | "uncertain" | "done-unknown" };

function isSchedulable(a: AutomationRecord): boolean {
  return Boolean(a.trigger?.day && a.condition && a.owner && a.asset && a.timezone && a.expiresAt);
}

export async function processAutomation(
  a: AutomationRecord,
  deps: WorkerDeps
): Promise<ProcessResult> {
  const now = deps.now();

  if (!isSchedulable(a)) {
    return { acted: false, reason: "legacy record without schedule data; skipping" };
  }

  const schedule = checkSchedule(a, now);
  if (!schedule.go) return { acted: false, reason: schedule.reason };
  const { localDate } = schedule;

  // Only touch the network on days it could matter.
  let balance: bigint | null = null;
  let allowance: bigint | null = null;
  try {
    [balance, allowance] = await Promise.all([
      deps.readBalance(a.owner, a.asset),
      deps.readAllowance(a.owner, a.asset),
    ]);
  } catch {
    // leave nulls: checkChainState reports "could not be read" and we retry next poll
  }

  const chain = checkChainState(a, { balance, allowance });
  if (!chain.go) return { acted: false, reason: chain.reason };

  // Persist intent BEFORE sending. This is what makes it at-most-once.
  await deps.update(a.id, (r) => {
    r.run = markSending(r.run, localDate);
  });
  deps.log(`[${a.id}] firing for ${localDate}`);

  try {
    const { hash, outcome } = await deps.execute(BigInt(a.onchainId), BigInt(a.amountBaseUnits));

    if (outcome.status === "success") {
      await deps.update(a.id, (r) => {
        r.run = markDone(r.run, localDate);
        r.lastExecution = { status: "success", txHash: hash, at: deps.now().toISOString() };
      });
      return { acted: true, result: "success" };
    }

    if (outcome.status === "rejected") {
      // The contract refused it. Retrying the same call won't change that today.
      await deps.update(a.id, (r) => {
        r.run = markDone(r.run, localDate);
        r.lastExecution = {
          status: "rejected",
          txHash: hash,
          reason: outcome.reason,
          at: deps.now().toISOString(),
        };
      });
      return { acted: true, result: "rejected" };
    }

    if (outcome.status === "reverted") {
      // Mined and reverted: no funds moved, so a later retry is safe.
      await deps.update(a.id, (r) => {
        r.run = markRetry(r.run, localDate, deps.now());
        r.lastExecution = {
          status: "error",
          txHash: hash,
          error: "Transaction reverted on-chain.",
          at: deps.now().toISOString(),
        };
      });
      return { acted: true, result: "retry" };
    }

    // Mined but no Executed/ExecutionRejected event: we cannot tell what happened.
    // Prefer not sending twice over retrying.
    await deps.update(a.id, (r) => {
      r.run = markDone(r.run, localDate);
      r.lastExecution = {
        status: "error",
        txHash: hash,
        error: "Confirmed, but the outcome could not be determined. Check the transaction.",
        at: deps.now().toISOString(),
      };
    });
    return { acted: true, result: "done-unknown" };
  } catch (err) {
    if (err instanceof ExecutionUncertainError) {
      // Sent, never confirmed. Leave run.state = "sending" so nothing resends today.
      await deps.update(a.id, (r) => {
        r.lastExecution = {
          status: "error",
          txHash: err.hash,
          error: "Sent but not confirmed; not retrying automatically. Check the transaction.",
          at: deps.now().toISOString(),
        };
      });
      return { acted: true, result: "uncertain" };
    }
    // Nothing was sent (pre-flight failed, or the send itself was rejected). Retry later.
    await deps.update(a.id, (r) => {
      r.run = markRetry(r.run, localDate, deps.now());
      r.lastExecution = {
        status: "error",
        error: shortError(err),
        at: deps.now().toISOString(),
      };
    });
    return { acted: true, result: "retry" };
  }
}

export async function pollOnce(deps: WorkerDeps): Promise<void> {
  const automations = await deps.listActive();
  for (const a of automations) {
    try {
      const r = await processAutomation(a, deps);
      if (r.acted) deps.log(`[${a.id}] ${r.result}`);
    } catch (err) {
      deps.log(`[${a.id}] unexpected error: ${shortError(err)}`);
    }
  }
}

/** Keep only the first line, and never echo anything that could contain an RPC URL. */
function shortError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  return msg.split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
}

export function realDeps(): WorkerDeps {
  return {
    now: () => new Date(),
    listActive: listActiveAutomations,
    update: updateAutomation,
    readBalance: readTokenBalanceOf,
    readAllowance,
    execute: attemptExecution,
    log: (m) => console.log(`${new Date().toISOString()} ${m}`),
  };
}

/** Refuse to start against the wrong chain or with a key the contract doesn't trust. */
async function preflight(): Promise<void> {
  const chainId = await getPublicClient().getChainId();
  if (chainId !== 421614) {
    throw new Error(`RPC is chain ${chainId}; expected Arbitrum Sepolia (421614).`);
  }
  const [onChain, mine] = [await readContractExecutor(), executorAccountAddress()];
  if (onChain.toLowerCase() !== mine.toLowerCase()) {
    throw new Error(
      `EXECUTOR_PRIVATE_KEY controls ${mine}, but the contract's executor is ${onChain}. ` +
        `Every execute() call would fail.`
    );
  }
}

export async function startTriggerWorker(): Promise<void> {
  await preflight();
  const deps = realDeps();
  const interval = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
  console.warn(
    "[triggerWorker] MVP placeholder: single process, single point of failure. " +
      "Run only ONE against this database."
  );
  console.log(`[triggerWorker] polling every ${interval}ms; db=${process.env.PULSE_DB_PATH ?? "default"}`);

  // Sequential loop (not setInterval) so a slow poll can never overlap the next one.
  for (;;) {
    try {
      await pollOnce(deps);
    } catch (err) {
      deps.log(`poll failed: ${shortError(err)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (require.main === module) {
  // Same repo-root .env the web app uses. Real environment variables win. (Node >= 20.12)
  try {
    process.loadEnvFile(path.resolve(process.cwd(), "..", ".env"));
  } catch {
    /* no .env file: rely on the real environment */
  }
  startTriggerWorker().catch((err) => {
    console.error("[triggerWorker] fatal:", shortError(err));
    process.exit(1);
  });
}
