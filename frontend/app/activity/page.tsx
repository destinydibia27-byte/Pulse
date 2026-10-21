"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { contractEventsUrl, formatDateTime } from "../../lib/explorer";
import { PULSE_CONTRACT_ADDRESS } from "../../lib/wagmiConfig";
import { Alert, EmptyState, ExplorerLink, StatusBadge } from "../components/ui";

type Entry = {
  key: string; automationId: string; label: string;
  status: string; txHash?: string; reason?: string; error?: string; at: string;
};

/** Every result the app has recorded. Older records only have their latest result, so use that. */
function flatten(automations: any[]): Entry[] {
  const out: Entry[] = [];
  for (const a of automations) {
    const hist: any[] = a.history?.length ? a.history : a.lastExecution ? [a.lastExecution] : [];
    hist.forEach((h, i) => out.push({ key: `${a.id}-${i}-${h.at}`, automationId: a.id, label: a.label, ...h }));
  }
  return out.sort((x, y) => (y.at > x.at ? 1 : -1));
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "success", label: "Sent" },
  { id: "rejected", label: "Refused" },
  { id: "error", label: "Errors" },
] as const;

export default function Activity() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/automations?userId=demo");
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      setEntries(flatten((await res.json()).automations ?? []));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { load(); }, []);

  const shown = useMemo(
    () => (entries ?? []).filter((e) => filter === "all" || e.status === filter),
    [entries, filter]
  );

  return (
    <main>
      <p className="eyebrow">Activity</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight text-navy">What actually happened</h1>
      <p className="mt-2 max-w-2xl text-slate-600">
        Every run Volo has recorded, newest first. A &ldquo;Sent&rdquo; entry links to its transaction so you can check it yourself.
      </p>

      <Alert tone="info" className="mt-6">
        History is recorded from when this version was installed. Automations that ran before it only show their latest
        result. The contract also logs every attempt on-chain
        {PULSE_CONTRACT_ADDRESS && (
          <>
            {" "}(<a className="font-semibold underline" href={contractEventsUrl(PULSE_CONTRACT_ADDRESS)} target="_blank" rel="noopener noreferrer">open its event log on Arbiscan</a>)
          </>
        )}
        .
      </Alert>

      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric ${
              filter === f.id ? "border-brand bg-brand text-white" : "border-line bg-white text-slate-700 hover:bg-brand-soft"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {error ? (
          <EmptyState title="Could not load activity" action={<button className="btn-secondary" onClick={load}>Try again</button>}>
            {error}
          </EmptyState>
        ) : entries === null ? (
          <div className="card h-40 animate-pulse" aria-label="Loading" />
        ) : entries.length === 0 ? (
          <EmptyState title="Nothing has run yet" action={<Link href="/" className="btn-primary">Create an automation</Link>}>
            Once an automation runs, or the contract refuses a run, it shows up here.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title="Nothing in this filter">Try another filter.</EmptyState>
        ) : (
          <ul className="card divide-y divide-line !p-0">
            {shown.map((e) => (
              <li key={e.key} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Link href={`/automation/${e.automationId}`} className="font-semibold text-navy hover:text-brand">{e.label}</Link>
                  <p className="mt-0.5 text-xs text-muted">{formatDateTime(e.at)}</p>
                  {(e.reason || e.error) && <p className="mt-1 text-sm text-slate-700">{e.reason ?? e.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StatusBadge status={e.status} />
                  {e.txHash && <ExplorerLink kind="tx" value={e.txHash} />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
