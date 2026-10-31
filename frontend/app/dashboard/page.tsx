"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { nextRunDate, isValidTimeZone } from "../../lib/scheduler";
import { formatDateTime, shortAddr } from "../../lib/explorer";
import { Alert, EmptyState, ExplorerLink, Spinner, StatusBadge } from "../components/ui";
import { useAutomationActions } from "../components/useAutomationActions";
import { useOnchainPermission } from "../components/useOnchain";
import { useOwnerAutomations } from "../components/useOwnerAutomations";
import { AccountGate } from "../components/AccountGate";

const USDC = (base: string | bigint) => formatUnits(BigInt(base), 6);
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
  const { address, automations, loading, loadError, load, setLoading } = useOwnerAutomations();
  const [created, setCreated] = useState(false);

  const actions = useAutomationActions(load);

  useEffect(() => {
    // Shown only when the review flow navigated here after the permission was really created.
    if (new URLSearchParams(window.location.search).get("created") === "1") {
      setCreated(true);
      window.history.replaceState(null, "", "/dashboard");
    }
  }, []);

  const counts = {
    active: automations.filter((a) => a.status === "active").length,
    paused: automations.filter((a) => a.status === "paused").length,
    ended: automations.filter((a) => a.status === "cancelled" || a.status === "expired").length,
  };

  return (
    <main>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-navy">Your automations</h1>
          <p className="mt-2 text-slate-600">What each one can do, what it last did, and what the contract says right now.</p>
        </div>
        <Link href="/" className="btn-primary self-start sm:self-auto">New automation</Link>
      </div>

      {created && (
        <Alert tone="success" title="Automation activated" className="mt-6">
          Its permission now exists on-chain. Nothing runs until its day and conditions are met.
        </Alert>
      )}
      {actions.error && <Alert tone="danger" className="mt-6">{actions.error}</Alert>}
      {actions.notice && <Alert tone="info" className="mt-6">{actions.notice}</Alert>}

      {loading ? (
        <div className="mt-8 grid gap-4 md:grid-cols-2" aria-label="Loading automations">
          {[0, 1].map((i) => <div key={i} className="card h-64 animate-pulse" />)}
        </div>
      ) : !address ? (
        <div className="mt-8">
          <AccountGate what="your automations" />
        </div>
      ) : loadError ? (
        <div className="mt-8">
          <EmptyState
            title="Could not load your automations"
            action={<button className="btn-secondary" onClick={() => { setLoading(true); load(); }}>Try again</button>}
          >
            {loadError}
          </EmptyState>
        </div>
      ) : automations.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No automations yet" action={<Link href="/" className="btn-primary">Describe your first automation</Link>}>
            Describe what you want in plain English, review the rules and permissions, then approve it in your wallet.{" "}
            <Link href="/welcome" className="font-semibold text-link underline">New here? See how it works.</Link>
          </EmptyState>
        </div>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-3 gap-3 sm:max-w-md">
            {[["Active", counts.active], ["Paused", counts.paused], ["Ended", counts.ended]].map(([label, n]) => (
              <div key={label as string} className="rounded-xl border border-line bg-card px-4 py-3">
                <dt className="text-xs font-medium text-muted">{label}</dt>
                <dd className="text-2xl font-bold tabular-nums text-navy">{n}</dd>
              </div>
            ))}
          </dl>
          <div className={automations.length === 1 ? "mt-6 max-w-2xl" : "mt-6 grid gap-4 md:grid-cols-2"}>
            {automations.map((a) => (
              <AutomationCard key={a.id} a={a} actions={actions} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function AutomationCard({ a, actions }: { a: any; actions: ReturnType<typeof useAutomationActions> }) {
  const { permission } = useOnchainPermission(a.onchainId);
  const s = schedule(a);
  const chain = permission?.status;
  const status = chain ?? a.status;
  const mismatch = chain && chain !== a.status ? chain : null;
  const working = actions.busy && actions.busy.id === a.id ? actions.busy.action : null;
  const syncAction = mismatch === "cancelled" ? "cancel" : mismatch === "paused" ? "pause" : mismatch === "active" ? "resume" : null;

  return (
    <article className="card flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-base font-semibold leading-snug text-navy">
          <Link href={`/automation/${a.id}`} className="hover:text-link">{a.label}</Link>
        </h2>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={status} />
          <span className="text-[11px] text-muted">{chain ? "read from the contract" : "app record"}</span>
        </div>
      </div>

      {mismatch && (
        <Alert tone="warning" className="mt-3">
          The app&apos;s record says <b>{a.status}</b>, but the contract says <b>{mismatch}</b>. The contract is what counts.
          {syncAction && (
            <button
              className="mt-2 block font-semibold underline"
              disabled={Boolean(working)}
              onClick={() => actions.sync(a, syncAction)}
            >
              {working === "sync" ? "Updating…" : "Update the app's record"}
            </button>
          )}
        </Alert>
      )}

      <dl className="mt-3 text-sm">
        <Row label="Sends">{a.amountBaseUnits ? `${USDC(a.amountBaseUnits)} USDC` : "—"} to {a.recipientLabel}</Row>
        {s ? <Row label="Rule">{s.rule}</Row> : <Row label="Rule">Schedule data unavailable (older record)</Row>}
        {s && status === "active" && <Row label="Next check">{s.next}</Row>}
        {permission && (
          <Row label="This week">
            {USDC(permission.spentInWindow)} of {USDC(permission.maxPerWindow)} USDC used
          </Row>
        )}
        <Row label="Last result">
          {a.lastExecution ? (
            <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              <StatusBadge status={a.lastExecution.status} />
              <span className="text-xs text-muted">{formatDateTime(a.lastExecution.at)}</span>
            </span>
          ) : (
            "Nothing has run yet"
          )}
        </Row>
        {a.lastExecution && (a.lastExecution.reason || a.lastExecution.error) && (
          <Row label="Detail">{a.lastExecution.reason ?? a.lastExecution.error}</Row>
        )}
        {a.lastExecution?.txHash && (
          <Row label="Transaction"><ExplorerLink kind="tx" value={a.lastExecution.txHash} /></Row>
        )}
      </dl>

      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        <Link href={`/automation/${a.id}`} className="btn-secondary">Details</Link>
        {status === "active" && (
          <button className="btn-secondary" disabled={Boolean(working)} onClick={() => actions.act(a, "pause")}>
            {working === "pause" && <Spinner />}{working === "pause" ? "Pausing on-chain…" : "Pause"}
          </button>
        )}
        {status === "paused" && (
          <button className="btn-secondary" disabled={Boolean(working)} onClick={() => actions.act(a, "resume")}>
            {working === "resume" && <Spinner />}{working === "resume" ? "Resuming on-chain…" : "Resume"}
          </button>
        )}
      </div>

      {status === "active" && (
        <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-muted">Demo tools</summary>
          <p className="mt-2">
            Submits a run right now instead of waiting for the worker. The contract still enforces the day, the
            once-per-day limit and your conditions, and may refuse it.
          </p>
          <button className="btn-secondary mt-2 !py-1.5" disabled={Boolean(working)} onClick={() => actions.act(a, "fire")}>
            {working === "fire" && <Spinner />}{working === "fire" ? "Submitting…" : "Run now (demo)"}
          </button>
        </details>
      )}
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-navy">{children}</dd>
    </div>
  );
}
