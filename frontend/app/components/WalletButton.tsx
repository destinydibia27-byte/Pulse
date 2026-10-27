"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { shortAddr } from "../../lib/explorer";
import { Spinner } from "./ui";

export function WalletButton() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

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

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        className="btn-primary !rounded-full !px-4 !py-2"
        disabled={isPending}
        onClick={() => connect({ connector: connectors[0] })}
      >
        {isPending && <Spinner />}
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
      {error && (
        <p role="alert" className="max-w-[16rem] text-right text-xs text-red-700">
          {/no provider|not found|undefined/i.test(error.message)
            ? "No browser wallet found. Install MetaMask, then try again."
            : error.message.split("\n")[0]}
        </p>
      )}
    </div>
  );
}
