"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { shortAddr } from "../../lib/explorer";
import { Spinner } from "./ui";

/** How long to wait for a wallet to answer before telling the person what to check. */
const SLOW_MS = 10_000;

/** Turns a wallet's error into one sentence a person can act on. */
function explainConnectError(message: string, code?: number): string {
  const m = message.toLowerCase();
  if (code === 4001 || m.includes("user rejected") || m.includes("user denied")) return "The request was declined in your wallet. Try again when you're ready.";
  if (code === -32002 || m.includes("already pending") || m.includes("already processing")) {
    return "Your wallet already has a request waiting. Open it and approve or reject it, then try again.";
  }
  if (/no provider|not found|undefined/i.test(message)) return "No browser wallet found. Install MetaMask, then try again.";
  return message.split("\n")[0];
}

export function WalletButton() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, isPending, error, reset, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [picking, setPicking] = useState(false);
  const [slow, setSlow] = useState(false);

  // A wallet that never answers must not leave the button spinning forever.
  useEffect(() => {
    if (!isPending) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [isPending]);

  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPicking(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  if (isConnected && address) {
    const wrongNetwork = !chain;
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1.5 text-sm" title={address}>
          <span
            className={`h-2 w-2 rounded-full ${wrongNetwork ? "bg-amber-500" : "bg-success"}`}
            aria-hidden="true"
          />
          <span className="sr-only">{wrongNetwork ? "Wrong network" : "Connected"}:</span>
          <span className="font-mono text-[13px] font-medium text-navy">{shortAddr(address)}</span>
          <span className="hidden text-xs text-muted lg:inline">{wrongNetwork ? "Wrong network" : chain.name}</span>
        </div>
        {wrongNetwork && (
          <button
            className="btn-secondary !px-3 !py-1.5"
            disabled={switching}
            onClick={() => switchChain({ chainId: arbitrumSepolia.id })}
          >
            {switching ? "Switching…" : "Switch to Arbitrum Sepolia"}
          </button>
        )}
        <button className="btn-ghost !px-2 !py-1.5" onClick={() => disconnect()} aria-label="Disconnect wallet">
          <span className="hidden sm:inline">Disconnect</span>
          <span className="sm:hidden" aria-hidden="true">✕</span>
        </button>
      </div>
    );
  }

  // Browsers announce each installed wallet by name. When any did, the generic "Injected" entry is
  // just a duplicate (and with several wallets installed it may point at the wrong one), so hide it.
  const named = connectors.filter((c) => c.id !== "injected");
  const wallets = named.length > 0 ? named : connectors;
  const connecting = variables?.connector && "name" in variables.connector ? variables.connector.name : "your wallet";

  function start(connector: (typeof connectors)[number]) {
    setPicking(false);
    connect({ connector });
  }

  return (
    <div className="relative">
      <button
        className="btn-primary !rounded-full !px-4 !py-2"
        disabled={isPending}
        aria-haspopup={wallets.length > 1 ? "menu" : undefined}
        aria-expanded={wallets.length > 1 ? picking : undefined}
        onClick={() => {
          reset();
          if (wallets.length > 1) setPicking((p) => !p);
          else if (wallets.length === 1) start(wallets[0]);
        }}
      >
        {isPending && <Spinner />}
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>

      {picking && wallets.length > 1 && (
        <div role="menu" aria-label="Choose a wallet" className="absolute right-0 top-full z-30 mt-2 w-56 rounded-2xl border border-line bg-card p-1.5 shadow-card">
          {wallets.map((w) => (
            <button
              key={w.uid}
              role="menuitem"
              onClick={() => start(w)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-navy hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric"
            >
              {w.icon ? <img src={w.icon} alt="" className="h-6 w-6 rounded" /> : <span className="h-6 w-6 rounded bg-surface" aria-hidden="true" />}
              {w.name}
            </button>
          ))}
        </div>
      )}

      {isPending && slow && (
        <div role="status" className="absolute right-0 top-full z-30 mt-2 w-64 rounded-2xl border border-line bg-card p-3 text-left text-xs text-slate-600 shadow-card">
          Waiting for {connecting}. Open the wallet extension, unlock it and approve the request.{" "}
          <button className="font-semibold text-link underline" onClick={() => { reset(); setPicking(false); }}>
            Cancel
          </button>
        </div>
      )}

      {error && !isPending && (
        <p role="alert" className="absolute right-0 top-full z-30 mt-2 w-64 rounded-2xl border border-red-300 bg-red-50 p-3 text-left text-xs text-red-800 shadow-card">
          {explainConnectError(error.message, (error as { code?: number }).code)}
        </p>
      )}
    </div>
  );
}
