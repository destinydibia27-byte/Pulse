"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { Alert, Spinner, StatusBadge } from "./components/ui";

const MAX_LEN = 280;
const MIN_LEN = 12;

// Each of these is checked against the real parser (including the offline fallback) before shipping.
const EXAMPLES = [
  { title: "Weekly savings", text: "Every Friday, send $10 to my savings wallet when my balance is above $100." },
  { title: "Monday top-up", text: "Every Monday, send $25 to my savings wallet if my balance is above $500." },
  { title: "Sunday sweep", text: "Every Sunday, send $5 to my savings wallet when my balance is above $50." },
];

const STEPS = [
  { n: "1", title: "Create", body: "Describe an onchain action in plain English." },
  { n: "2", title: "Control", body: "Review the exact rules and permissions before you approve anything." },
  { n: "3", title: "Verify", body: "Every run is a transaction you can open on Arbiscan, next to the contract's own status." },
];

export default function Home() {
  const router = useRouter();
  const { isConnected } = useAccount();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const trimmed = text.trim();
  const validation = !trimmed
    ? "Describe what you want to automate."
    : trimmed.length < MIN_LEN
    ? "Add a few more details so Volo can read it."
    : null;
  const showValidation = touched && validation;

  async function handleSubmit() {
    setTouched(true);
    if (validation) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.reason ?? "Could not understand that request.");
        return;
      }
      sessionStorage.setItem("pulse.pendingIntent", JSON.stringify(data));
      router.push("/review");
    } catch (e) {
      setError(`Could not reach Volo: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section>
        <p className="eyebrow">Automate</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-navy sm:text-4xl">Describe your automation</h1>
        <p className="mt-3 max-w-xl text-base text-slate-600">
          Tell Volo what you want in plain English. You will see the exact rules and permissions before anything is activated.
        </p>

        <form
          className="card mt-6"
          onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
          noValidate
        >
          <label htmlFor="intent" className="text-sm font-semibold text-navy">
            What do you want to automate?
          </label>
          <textarea
            id="intent"
            rows={5}
            maxLength={MAX_LEN}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
            placeholder="Every Friday, send $10 to my savings wallet when my balance is above $100."
            aria-describedby="intent-help intent-count"
            aria-invalid={Boolean(showValidation)}
            className={`input mt-2 resize-none leading-relaxed ${showValidation ? "!border-red-400" : ""}`}
          />
          <div className="mt-2 flex items-start justify-between gap-4 text-xs">
            <p id="intent-help" className={showValidation ? "font-medium text-red-700" : "text-slate-500"}>
              {showValidation ? validation : "Include the day, the amount, where it goes, and the condition."}
            </p>
            <p id="intent-count" className={`shrink-0 tabular-nums ${text.length >= MAX_LEN ? "font-semibold text-red-700" : "text-slate-500"}`}>
              {text.length}/{MAX_LEN}
            </p>
          </div>

          <div className="mt-4">
            <p className="eyebrow">Try an example</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.title}
                  type="button"
                  onClick={() => { setText(ex.text); setError(null); setTouched(false); }}
                  className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-brand hover:bg-brand-soft hover:text-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric"
                >
                  {ex.title}
                </button>
              ))}
            </div>
          </div>

          {error && <Alert tone="danger" title="Volo could not build that" className="mt-4">{error}</Alert>}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button type="submit" className="btn-primary sm:min-w-44" disabled={loading}>
              {loading && <Spinner />}
              {loading ? "Reading your request…" : "Build automation"}
            </button>
            <p className="text-xs text-slate-500">
              Nothing is created or activated yet. You will review the rules, then approve in your wallet.
            </p>
          </div>
        </form>

        {!isConnected && (
          <Alert tone="info" className="mt-4">
            You can build and review without a wallet. You will connect one (top right) to approve.
          </Alert>
        )}
      </section>

      <aside className="space-y-4">
        <div className="card">
          <p className="eyebrow">How Volo works</p>
          <ol className="mt-3 space-y-4">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white" aria-hidden="true">
                  {s.n}
                </span>
                <div>
                  <p className="text-sm font-semibold text-navy">{s.title}</p>
                  <p className="text-sm text-slate-600">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <RecentAutomations />
      </aside>
    </main>
  );
}

function RecentAutomations() {
  const [items, setItems] = useState<any[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/automations?userId=demo")
      .then((r) => r.json())
      .then((d) => setItems(d.automations ?? []))
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Your automations</p>
        <Link href="/dashboard" className="text-xs font-semibold text-brand hover:underline">View all →</Link>
      </div>
      <div className="mt-3">
        {failed ? (
          <p className="text-sm text-slate-600">Could not load your automations right now.</p>
        ) : items === null ? (
          <div className="space-y-2" aria-label="Loading">
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-slate-600">No automations yet. Describe one on the left to get started.</p>
        ) : (
          <ul className="space-y-2.5">
            {items.slice(-3).reverse().map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3">
                <Link href={`/automation/${a.id}`} className="min-w-0 truncate text-sm font-medium text-navy hover:text-brand">
                  {a.label}
                </Link>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
