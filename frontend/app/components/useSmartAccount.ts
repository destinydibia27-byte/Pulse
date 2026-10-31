"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address, Hex } from "viem";
import { buildSmartAccount, explainSmartError, zerodevEnabled, type SmartAccountHandle, type SmartCall } from "../../lib/zerodev";

// One smart account per connected wallet, shared by every component that asks for it, so the page
// does not repeat the address lookup. A failed build is dropped so the next render can retry.
const cache = new Map<string, Promise<SmartAccountHandle>>();

export interface UseSmartAccount {
  /** True when NEXT_PUBLIC_ZERODEV_PROJECT_ID is set. When false, nothing else here does anything. */
  enabled: boolean;
  /** The smart account's address once it is ready. */
  address?: Address;
  loading: boolean;
  error?: string;
  send: (calls: SmartCall[]) => Promise<{ userOpHash: Hex; receipt: Awaited<ReturnType<SmartAccountHandle["sendCalls"]>>["receipt"] }>;
  sign: (message: string) => Promise<Hex>;
}

export function useSmartAccount(): UseSmartAccount {
  const { address: eoa } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [handle, setHandle] = useState<SmartAccountHandle | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const handleRef = useRef<SmartAccountHandle | undefined>();
  handleRef.current = handle;

  const walletAddr = walletClient?.account?.address?.toLowerCase();
  useEffect(() => {
    setHandle(undefined);
    setError(undefined);
    if (!zerodevEnabled || !eoa || !walletClient || !publicClient || walletAddr !== eoa.toLowerCase()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const key = eoa.toLowerCase();
    let p = cache.get(key);
    if (!p) {
      p = buildSmartAccount(walletClient, publicClient as any);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    p.then((h) => { if (!cancelled) setHandle(h); })
      .catch((e) => { if (!cancelled) setError(explainSmartError(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // walletClient/publicClient objects can change identity between renders; the address is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eoa, walletAddr, Boolean(publicClient)]);

  const send = useCallback<UseSmartAccount["send"]>(async (calls) => {
    const h = handleRef.current;
    if (!h) throw new Error("The smart account is not ready yet.");
    try {
      return await h.sendCalls(calls);
    } catch (e) {
      throw new Error(explainSmartError(e));
    }
  }, []);

  const sign = useCallback<UseSmartAccount["sign"]>(async (message) => {
    const h = handleRef.current;
    if (!h) throw new Error("The smart account is not ready yet.");
    try {
      return await h.signMessage(message);
    } catch (e) {
      throw new Error(explainSmartError(e));
    }
  }, []);

  return { enabled: zerodevEnabled, address: handle?.address, loading, error, send, sign };
}
