"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

/**
 * The connected wallet's own automations. The user IS the wallet: nothing is listed until a wallet
 * is connected, and the server only ever returns the records filed under that address.
 * `walletPending` is true while the wallet extension is still reconnecting after a page load, so
 * pages can show a loading state instead of flashing "connect your wallet".
 */
export function useOwnerAutomations() {
  const { address, status } = useAccount();
  const walletPending = status === "connecting" || status === "reconnecting";
  const [automations, setAutomations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) {
      setAutomations([]);
      setLoadError(null);
      setLoading(walletPending);
      return;
    }
    try {
      const res = await fetch(`/api/automations?owner=${address}`);
      if (!res.ok) throw new Error(res.status === 429 ? "Too many requests. Wait a minute and try again." : `The server answered ${res.status}.`);
      setAutomations((await res.json()).automations ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address, walletPending]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  return { address, walletPending, automations, loading, loadError, load, setLoading };
}
