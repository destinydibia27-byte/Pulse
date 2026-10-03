"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WalletButton } from "./components/WalletButton";

export default function Home() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit() {
    if (!text.trim()) return;
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
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pulse</h1>
          <p className="mt-1 text-neutral-500">Make your wallet work for you.</p>
        </div>
        <WalletButton />
      </div>

      <div className="card space-y-3">
        <label className="text-sm font-medium text-neutral-700">
          What do you want to automate?
        </label>
        <textarea
          className="w-full resize-none rounded-xl border border-neutral-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
          rows={3}
          placeholder='"Every Friday send $10 to my savings wallet if my balance is above $100"'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary" onClick={handleSubmit} disabled={loading}>
          {loading ? "Thinking…" : "Create automation"}
        </button>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-neutral-500">Active automations</h2>
        <a href="/dashboard" className="pill">View dashboard →</a>
      </div>
    </main>
  );
}
