"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOwnerAutomations } from "../components/useOwnerAutomations";

const STEPS = [
  { n: "1", title: "Create", body: "Describe an onchain action in plain English." },
  { n: "2", title: "Control", body: "Review the exact rules and permissions before you approve anything." },
  { n: "3", title: "Verify", body: "Every run is a transaction you can open on Arbiscan, next to the contract's own status." },
];

function Tick({ done }: { done: boolean }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
        done ? "border-success bg-success-soft text-green-700" : "border-line bg-surface text-slate-600"
      }`}
      aria-hidden="true"
    >
      {done ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5 10 17.5 19 7.5" />
        </svg>
      ) : null}
    </span>
  );
}

export default function Welcome() {
  const { address, automations, loading } = useOwnerAutomations();
  const [recipientCount, setRecipientCount] = useState<number | null>(null);

  useEffect(() => {
    if (!address) { setRecipientCount(null); return; }
    let cancelled = false;
    fetch(`/api/recipients?owner=${address}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setRecipientCount(Object.keys(d.recipients ?? {}).length); })
      .catch(() => { if (!cancelled) setRecipientCount(null); });
    return () => { cancelled = true; };
  }, [address]);

  const checklist = [
    {
      done: Boolean(address),
      title: "Connect your wallet",
      body: "Use the button at the top right. Your automations are filed under your wallet address, and only your wallet can change them.",
      action: null as null | { href: string; label: string },
    },
    {
      done: (recipientCount ?? 0) > 0,
      title: "Save a recipient",
      body: "Choose where the money goes, for example a wallet you call “savings”. Only addresses you save here can ever receive money from your automations.",
      action: { href: "/settings", label: "Open Settings" },
    },
    {
      done: !loading && automations.length > 0,
      title: "Create your first automation",
      body: "Describe it in plain English, review the exact rules, then approve it in your wallet. You can build and review a rule before you connect.",
      action: { href: "/", label: "Describe an automation" },
    },
  ];
  // The first step that still needs doing and has a button gets the highlighted button.
  const next = checklist.findIndex((c) => !c.done && c.action);

  return (
    <main>
      <p className="eyebrow">Welcome</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight text-navy sm:text-4xl">How Volo works</h1>
      <p className="mt-2 max-w-2xl text-slate-600">
        Volo turns a sentence into a rule the blockchain enforces. The AI only reads your text. It can never move money. The contract
        enforces the limits you approve.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section className="card" aria-labelledby="how">
          <h2 id="how" className="eyebrow">The idea</h2>
          <ol className="mt-4 space-y-5">
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
        </section>

        <section className="card" aria-labelledby="start">
          <h2 id="start" className="eyebrow">Get started</h2>
          <ol className="mt-4 space-y-5">
            {checklist.map((c, i) => (
              <li key={c.title} className="flex gap-3">
                <Tick done={c.done} />
                <div>
                  <p className="text-sm font-semibold text-navy">
                    {c.title}
                    {c.done && <span className="sr-only"> (done)</span>}
                  </p>
                  <p className="text-sm text-slate-600">{c.body}</p>
                  {c.action && !c.done && (
                    <Link href={c.action.href} className={`mt-2 inline-flex ${i === next ? "btn-primary" : "btn-secondary"} !py-1.5`}>
                      {c.action.label}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="card mt-6" aria-labelledby="testnet">
        <h2 id="testnet" className="eyebrow">Before you try it</h2>
        <p className="mt-3 text-sm text-slate-600">
          Volo runs on the Arbitrum Sepolia <strong className="text-navy">test network</strong>. Everything uses test tokens with no real value, and
          the contract is unaudited. You need a little test ETH for gas and some test USDC in the wallet you connect. Both are free from public
          test-network faucets. Please don&apos;t use funds you cannot afford to lose.
        </p>
        <p className="mt-3 text-sm text-slate-600">
          To read your sentence, Volo sends the text you type to an AI service. It sees only that text, never your wallet or keys. Don&apos;t type
          private keys, seed phrases or anything secret into a rule.
        </p>
      </section>
    </main>
  );
}
