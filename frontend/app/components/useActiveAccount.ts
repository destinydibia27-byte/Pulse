"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { Address, Hex } from "viem";
import { useSmartAccount } from "./useSmartAccount";

/**
 * "Who am I in Volo?" in one place.
 *
 * A person is the address that owns their automations and recipients. That is either their wallet
 * ("wallet" mode) or, when gasless smart accounts are configured, the smart account their wallet
 * controls ("smart" mode, the default). Every page asks this hook instead of asking wagmi directly,
 * so the identity, the signature and the list of automations always agree.
 *
 * The two identities are separate on purpose: a smart account is a different address from the
 * wallet that controls it, so its recipients and automations are its own.
 */
export type AccountMode = "smart" | "wallet";
const KEY = "volo-account-mode";
/**
 * Which account people get before they choose. "wallet" until gasless accounts have been proven
 * against the real ZeroDev service; then change this to "smart" and everyone who never chose gets it.
 */
const DEFAULT_MODE: AccountMode = "wallet";
const listeners = new Set<() => void>();

function readStored(): AccountMode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "smart" || v === "wallet" ? v : null;
  } catch {
    return null;
  }
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) cb(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}
function store(mode: AccountMode) {
  try { localStorage.setItem(KEY, mode); } catch {}
  listeners.forEach((l) => l());
}

export function useActiveAccount() {
  const { address: eoa, status } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const smart = useSmartAccount();
  const stored = useSyncExternalStore(subscribe, readStored, () => null);

  const mode: AccountMode = smart.enabled ? stored ?? DEFAULT_MODE : "wallet";
  const isSmart = smart.enabled && mode === "smart";
  const address: Address | undefined = isSmart ? smart.address : eoa;

  const sign = useCallback(
    async (message: string): Promise<Hex> => (isSmart ? smart.sign(message) : signMessageAsync({ message })),
    [isSmart, smart.sign, signMessageAsync]
  );

  return {
    /** The address that owns this person's automations and recipients. */
    address,
    /** The connected wallet itself (always the one that signs for a smart account). */
    eoa,
    connected: Boolean(eoa),
    isSmart,
    mode,
    setMode: store,
    smartEnabled: smart.enabled,
    smart,
    sign,
    /** The wallet extension is still reconnecting after a page load. */
    walletPending: status === "connecting" || status === "reconnecting",
    /** Connected, but the smart account's address is still being worked out. */
    preparing: isSmart && Boolean(eoa) && !smart.address && smart.loading,
  };
}
