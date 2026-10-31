"use client";

import { useCallback, useEffect, useState } from "react";
import { buildRecipientRemoveMessage, buildRecipientSetMessage } from "../../lib/auth";
import { checkRecipientAddress, normalizeLabel, MAX_RECIPIENTS_PER_USER } from "../../lib/recipients";
import { Alert, EmptyState, ExplorerLink, Spinner } from "../components/ui";
import { useActiveAccount } from "../components/useActiveAccount";

type Book = Record<string, string>;

export default function Settings() {
  const account = useActiveAccount();
  const { address, sign, walletPending: reconnecting, preparing } = account;
  const [book, setBook] = useState<Book | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("savings");
  const [addr, setAddr] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) { setBook(null); return; }
    try {
      const res = await fetch(`/api/recipients?owner=${address}`);
      if (!res.ok) throw new Error(res.status === 429 ? "Too many requests. Wait a minute and try again." : `The server answered ${res.status}.`);
      setBook((await res.json()).recipients ?? {});
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [address]);
  useEffect(() => { load(); }, [load]);

  // Validate as the person types, with the same rules the server applies.
  const cleanLabel = normalizeLabel(label);
  const checked = addr.trim() ? checkRecipientAddress(addr.trim()) : null;
  const addressProblem = checked && !checked.ok ? checked.reason : null;
  const ready = Boolean(cleanLabel && checked?.ok && confirmed && address && !busy);
  const replacing = cleanLabel && book && cleanLabel in book;

  async function post(payload: Record<string, unknown>) {
    const res = await fetch("/api/recipients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.reason ?? `The server answered ${res.status}.`);
    setBook(data.recipients);
  }

  async function save() {
    if (!ready || !cleanLabel || !checked?.ok || !address) return;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const timestamp = Date.now();
      const signature = await sign(buildRecipientSetMessage(address, cleanLabel, checked.address, timestamp));
      await post({ op: "set", owner: address, label: cleanLabel, address: checked.address, signature, timestamp });
      setNotice(`Saved. “${cleanLabel}” now sends to ${checked.address}.`);
      setAddr(""); setConfirmed(false);
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  async function remove(l: string) {
    if (!address) return;
    setBusy(`remove:${l}`); setError(null); setNotice(null);
    try {
      const timestamp = Date.now();
      const signature = await sign(buildRecipientRemoveMessage(address, l, timestamp));
      await post({ op: "remove", owner: address, label: l, signature, timestamp });
      setNotice(`Removed “${l}”. Automations already created keep the address they were created with.`);
      setRemoving(null);
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  const accountCard = account.smartEnabled && account.connected && (
        <section className="card mt-6" aria-labelledby="acct">
          <h2 id="acct" className="text-base font-semibold text-navy">Account</h2>
          <p className="mt-1 text-sm text-slate-600">
            Volo can run your automations from a <strong className="text-navy">smart account</strong> your wallet controls, with gas paid for you, or
            straight from your wallet. Your recipients and automations belong to the account you choose, so switching shows a different set.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="acct">
            {([
              ["smart", "Smart account (gasless)", "No gas to pay. The USDC to be sent is held in the smart account, which is a separate address from your wallet."],
              ["wallet", "My wallet", "The permission belongs to your wallet and you pay gas for each transaction."],
            ] as const).map(([value, title, blurb]) => (
              <label key={value} className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm ${account.mode === value ? "border-brand bg-surface" : "border-line"}`}>
                <span className="flex items-center gap-2 font-semibold text-navy">
                  <input type="radio" name="account" checked={account.mode === value} onChange={() => account.setMode(value)} className="accent-brand focus-visible:ring-2 focus-visible:ring-electric" />
                  {title}
                </span>
                <span className="text-slate-600">{blurb}</span>
              </label>
            ))}
          </div>
          {account.isSmart && account.smart.loading && <p className="mt-3 text-sm text-slate-600">Preparing your smart account…</p>}
          {account.isSmart && account.smart.error && <Alert tone="danger" title="Could not prepare the smart account" className="mt-3">{account.smart.error}</Alert>}
          {account.isSmart && account.smart.address && (
            <p className="mt-3 text-sm text-slate-700">Smart account: <ExplorerLink kind="address" value={account.smart.address} /></p>
          )}
        </section>
  );

  const walletPending = reconnecting || preparing;
  if (!address) {
    return (
      <main>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-navy">Your recipients</h1>
        {/* Connected but the smart account is not ready: keep the way out (switch to the wallet) in reach. */}
        {!walletPending && accountCard}
        <div className="mt-8">
          {walletPending ? (
            <div className="card h-32 animate-pulse" aria-label="Loading" />
          ) : account.connected ? (
            <p className="text-sm text-slate-600">Your recipients appear here once your account is ready.</p>
          ) : (
            <EmptyState title="Connect your wallet">Recipients belong to your account, so connect your wallet (top right) to see and edit them.</EmptyState>
          )}
        </div>
      </main>
    );
  }

  return (
    <main>
      <p className="eyebrow">Settings</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight text-navy">Your recipients</h1>
      <p className="mt-2 max-w-2xl text-slate-600">
        When you write &ldquo;send $10 to my savings wallet&rdquo;, Volo looks up &ldquo;savings&rdquo; here. Only addresses you save
        here can ever receive money from your automations, and the contract locks the address in when a permission is created.
      </p>

      {accountCard}

      {error && <Alert tone="danger" title="That did not work" className="mt-6">{error}</Alert>}
      {notice && <Alert tone="success" className="mt-6">{notice}</Alert>}

      <section className="card mt-6" aria-labelledby="saved">
        <h2 id="saved" className="text-base font-semibold text-navy">Saved recipients</h2>
        {loadError ? (
          <p className="mt-3 text-sm text-slate-700">Could not load them: {loadError} <button className="font-semibold text-link underline" onClick={load}>Try again</button></p>
        ) : book === null ? (
          <div className="mt-3 h-10 animate-pulse rounded bg-surface" aria-label="Loading" />
        ) : Object.keys(book).length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">None yet. Add one below. Automations that name an unsaved recipient are refused.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {Object.entries(book).map(([l, a]) => (
              <li key={l} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-semibold text-navy">{l}</p>
                  <p className="break-all font-mono text-[13px] text-slate-700"><ExplorerLink kind="address" value={a}>{a}</ExplorerLink></p>
                </div>
                {removing === l ? (
                  <div className="flex items-center gap-2">
                    <button className="btn-secondary !py-1.5" onClick={() => setRemoving(null)} disabled={busy !== null}>Keep</button>
                    <button className="btn-secondary !py-1.5 !text-red-700" onClick={() => remove(l)} disabled={busy !== null}>
                      {busy === `remove:${l}` && <Spinner />}Remove
                    </button>
                  </div>
                ) : (
                  <button className="btn-secondary !py-1.5" onClick={() => setRemoving(l)} disabled={busy !== null}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">
          You can save up to {MAX_RECIPIENTS_PER_USER}. Anyone who knows your wallet address can read this list, and an address becomes public
          on-chain once a permission uses it.
        </p>
      </section>

      <section className="card mt-6" aria-labelledby="add">
        <h2 id="add" className="text-base font-semibold text-navy">{replacing ? "Replace a recipient" : "Add a recipient"}</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <label className="text-sm font-medium text-navy">
            Name
            <input
              value={label}
              onChange={(e) => { setLabel(e.target.value); setConfirmed(false); }}
              maxLength={40}
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric"
              aria-invalid={!cleanLabel}
            />
            <span className="mt-1 block text-xs font-normal text-muted">The word you use in your rule, like &ldquo;savings&rdquo;.</span>
          </label>
          <label className="text-sm font-medium text-navy">
            Wallet address
            <input
              value={addr}
              onChange={(e) => { setAddr(e.target.value); setConfirmed(false); }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 font-mono text-[13px] font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric"
              aria-invalid={Boolean(addressProblem)}
            />
            {addressProblem && <span className="mt-1 block text-xs font-normal text-red-700">{addressProblem}</span>}
          </label>
        </div>
        {!cleanLabel && label.trim() !== "" && (
          <p className="mt-2 text-xs text-red-700">Names use 1 to 32 letters, numbers, spaces, dashes or underscores, and start with a letter or number.</p>
        )}

        {cleanLabel && checked?.ok && (
          <div className="mt-4 rounded-xl border border-line bg-surface p-4 text-sm">
            <p className="font-semibold text-navy">Check this carefully</p>
            <p className="mt-1 text-slate-700">
              Automations that say &ldquo;{cleanLabel}&rdquo; will send USDC to:
            </p>
            <p className="mt-2 break-all rounded-lg bg-card px-3 py-2 font-mono text-[13px] text-navy">{checked.address}</p>
            <p className="mt-2 text-slate-600">
              A wrong address means lost money, and the blockchain cannot undo it. Compare it with your wallet, character by character, and
              try a very small amount first.
            </p>
            <label className="mt-3 flex cursor-pointer items-start gap-3 text-navy">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-line accent-brand focus-visible:ring-2 focus-visible:ring-electric"
              />
              <span>This is my address and I have checked every character.</span>
            </label>
          </div>
        )}

        <button className="btn-primary mt-4" onClick={save} disabled={!ready}>
          {busy === "save" && <Spinner />}{busy === "save" ? "Waiting for your wallet…" : replacing ? "Sign and replace" : "Sign and save"}
        </button>
        <p className="mt-2 text-xs text-muted">Your wallet will ask for a signature. It costs no gas and moves no money.</p>
      </section>
    </main>
  );
}
