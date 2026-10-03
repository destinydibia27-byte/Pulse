"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button className="pill" onClick={() => disconnect()}>
        {address.slice(0, 6)}…{address.slice(-4)} · Disconnect
      </button>
    );
  }

  return (
    <button
      className="pill"
      disabled={isPending}
      onClick={() => connect({ connector: connectors[0] })}
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
