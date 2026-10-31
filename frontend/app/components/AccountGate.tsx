"use client";

import Link from "next/link";
import { EmptyState } from "./ui";
import { useActiveAccount } from "./useActiveAccount";

/**
 * What to show when there is no usable account yet. Three different situations, three different
 * messages, so nobody is told to "connect" a wallet that is already connected:
 *   - no wallet connected
 *   - the smart account is still being prepared
 *   - the smart account cannot be prepared (with a way out: switch to the wallet in Settings)
 */
export function AccountGate({ what }: { what: string }) {
  const a = useActiveAccount();
  if (!a.connected) {
    return (
      <EmptyState title="Connect your wallet" action={<span className="text-sm text-slate-600">Use the button at the top right.</span>}>
        Volo files {what} under your account, so connect to see them.
      </EmptyState>
    );
  }
  if (a.preparing || a.walletPending) {
    return <div className="card h-32 animate-pulse" aria-label="Preparing your account" />;
  }
  return (
    <EmptyState
      title="Your smart account isn't available right now"
      action={<Link href="/settings" className="btn-primary">Open Settings</Link>}
    >
      {a.smart.error ? `${a.smart.error} ` : ""}You can switch to your own wallet in Settings and come back.
    </EmptyState>
  );
}
