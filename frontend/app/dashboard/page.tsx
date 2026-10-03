"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { useWriteContract, usePublicClient, useSignMessage } from "wagmi";
import { PULSE_ABI } from "../../lib/abi";
import { PULSE_CONTRACT_ADDRESS } from "../../lib/wagmiConfig";
import { nextRunDate, isValidTimeZone } from "../../lib/scheduler";
import { buildActionMessage } from "../../lib/auth";

const USDC = (base: string) => formatUnits(BigInt(base), 6);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** e.g. "Fri, Oct 2". Pure calendar date, so it never shifts with the viewer's timezone. */
function prettyDate(ymd: string) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

function schedule(a: any) {
  if (!a.trigger || !a.condition) return null; // older record without schedule data
  const tz = isValidTimeZone(a.timezone) ? a.timezone : "UTC";
  const doneToday = a.run?.state === "done" || a.run?.state === "sending";
  const today = new Date();
  // run.date is the local date the state refers to; only "today" counts as done today
  const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(today);
  const next = nextRunDate(a.trigger.day, tz, today, Boolean(doneToday && a.run?.date === localToday));
  return {
    tz,
    next: prettyDate(next),
    rule: `Every ${cap(a.trigger.day)} (${tz}) if USDC ${a.condition.operator} $${USDC(a.condition.thresholdBaseUnits)}`,
  };
}

export default function Dashboard() {
  const [automations, setAutomations] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();

  async function load() {
    const res = await fetch("/api/automations?userId=demo");
    const data = await res.json();
    setAutomations(data.automations ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function act(a: any, action: "pause" | "resume" | "fire") {
    setError(null);
    setNotice(null);
    try {
      // pause/resume must succeed on-chain before the DB is touched.
      if (action === "pause" || action === "resume") {
        const hash = await writeContractAsync({
          address: PULSE_CONTRACT_ADDRESS,
          abi: PULSE_ABI,
          functionName: action,
          args: [BigInt(a.onchainId)],
        });
        await publicClient!.waitForTransactionReceipt({ hash });
      }
      // Prove control of the automation's owner wallet for THIS exact action.
      const timestamp = Date.now();
      const signature = await signMessageAsync({
        message: buildActionMessage(a.id, action, timestamp),
      });
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "demo", automationId: a.id, action, signature, timestamp }),
      });
      const data = await res.json();
      if (action === "fire") {
        if (!data.ok) setError(data.reason ?? "Could not fire.");
        else if (data.mock) setNotice(data.message);
        else if (data.outcome === "rejected") setNotice(`The contract refused it: ${data.reason}`);
        else setNotice("Sent. The contract accepted it.");
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Automations</h1>
        <Link href="/" className="pill">+ New</Link>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-neutral-600">{notice}</p>}

      {automations.length === 0 && (
        <p className="text-sm text-neutral-500">No automations yet.</p>
      )}

      <div className="space-y-3">
        {automations.map((a) => {
          const sch = schedule(a);
          return (
            <div key={a.id} className="card space-y-2">
              <div className="flex items-center justify-between">
                <Link href={`/automation/${a.id}`} className="font-medium">{a.label}</Link>
                <span className="pill">{a.status}</span>
              </div>
              {sch ? (
                <>
                  <p className="text-xs text-neutral-500">
                    Sends {USDC(a.amountBaseUnits)} USDC to {a.recipientLabel}
                  </p>
                  <p className="text-xs text-neutral-500">{sch.rule}</p>
                  {a.status === "active" && (
                    <p className="text-xs text-neutral-500">
                      Next check: {sch.next}. It sends only if your balance condition holds that day.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-amber-600">
                  Created before schedules were stored. It will not run automatically.
                </p>
              )}
              {a.lastExecution && (
                <p className="text-xs text-neutral-500">
                  Last: {a.lastExecution.status}{" "}
                  {a.lastExecution.reason ?? a.lastExecution.error ?? a.lastExecution.txHash ?? ""}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                {a.status === "active" && (
                  <button className="btn-secondary" onClick={() => act(a, "pause")}>Pause</button>
                )}
                {a.status === "paused" && (
                  <button className="btn-secondary" onClick={() => act(a, "resume")}>Resume</button>
                )}
                <button
                  className="btn-secondary"
                  title="Demo only: ignores the schedule and balance condition"
                  onClick={() => act(a, "fire")}
                >
                  Run now (demo)
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
