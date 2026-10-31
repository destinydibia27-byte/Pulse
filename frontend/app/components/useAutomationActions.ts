"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";
import { encodeFunctionData } from "viem";
import { PULSE_ABI } from "../../lib/abi";
import { PULSE_CONTRACT_ADDRESS } from "../../lib/wagmiConfig";
import { buildActionMessage } from "../../lib/auth";
import { shortAddr } from "../../lib/explorer";
import { useSmartAccount } from "./useSmartAccount";

export type Action = "pause" | "resume" | "cancel" | "fire";

/**
 * Pause, resume, cancel and the demo "run now", shared by the dashboard and the detail page.
 * Order matters and is unchanged from before: pause/resume/cancel must succeed ON-CHAIN first, and
 * only then is the app's record updated (with a fresh wallet signature for that exact action), so
 * the UI can never claim a state the contract does not have.
 */
export function useAutomationActions(onChanged?: () => void) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();
  const smart = useSmartAccount();
  const [busy, setBusy] = useState<{ id: string; action: Action | "sync" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isSmartOwned = (a: any) =>
    Boolean(smart.address && a.owner && smart.address.toLowerCase() === String(a.owner).toLowerCase());

  async function postRecord(a: any, action: Action) {
    const automationId = a.id as string;
    const timestamp = Date.now();
    const message = buildActionMessage(automationId, action, timestamp);
    const signature = isSmartOwned(a) ? await smart.sign(message) : await signMessageAsync({ message });
    const res = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automationId, action, signature, timestamp }),
    });
    return res.json();
  }

  function checkWallet(a: any): string | null {
    if (!address) return "Connect your wallet first.";
    if (!a.owner) return null;
    const owner = String(a.owner).toLowerCase();
    if (address.toLowerCase() === owner) return null;
    if (isSmartOwned(a)) return null;
    if (smart.enabled && smart.loading) return "Preparing your smart account. Try again in a moment.";
    return `This automation belongs to ${shortAddr(a.owner)}. Switch your wallet to ${
      smart.enabled ? "that account, or to the wallet that controls it" : "that account"
    }.`;
  }

  async function act(a: any, action: Action): Promise<boolean> {
    setError(null);
    setNotice(null);
    const problem = checkWallet(a);
    if (problem) { setError(problem); return false; }

    setBusy({ id: a.id, action });
    let onchainDone = false;
    try {
      if (action === "pause" || action === "resume" || action === "cancel") {
        if (isSmartOwned(a)) {
          await smart.send([
            {
              to: PULSE_CONTRACT_ADDRESS,
              data: encodeFunctionData({ abi: PULSE_ABI, functionName: action, args: [BigInt(a.onchainId)] }),
            },
          ]);
        } else {
          const hash = await writeContractAsync({
            address: PULSE_CONTRACT_ADDRESS,
            abi: PULSE_ABI,
            functionName: action,
            args: [BigInt(a.onchainId)],
          });
          await publicClient!.waitForTransactionReceipt({ hash });
        }
        onchainDone = true;
      }
      const data = await postRecord(a, action);
      if (action === "fire") {
        if (!data.ok) setError(data.reason ?? "Could not run it.");
        else if (data.mock) setNotice(data.message);
        else if (data.outcome === "rejected") setNotice(`The contract refused it: ${data.reason}`);
        else setNotice("Sent. The contract accepted it.");
      } else if (!data.ok) {
        throw new Error(data.reason ?? "The app could not record this change.");
      }
      onChanged?.();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        onchainDone
          ? `The change went through on-chain, but the app's record was not updated (${msg}). The contract is the source of truth; use "Update record" to sync the app.`
          : msg
      );
      if (onchainDone) onChanged?.();
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** Record-only: bring the app's label in line with what the contract already says. No on-chain tx. */
  async function sync(a: any, action: Exclude<Action, "fire">): Promise<boolean> {
    setError(null);
    setNotice(null);
    const problem = checkWallet(a);
    if (problem) { setError(problem); return false; }
    setBusy({ id: a.id, action: "sync" });
    try {
      const data = await postRecord(a, action);
      if (!data.ok) throw new Error(data.reason ?? "The app could not record this change.");
      setNotice("The app's record now matches the contract.");
      onChanged?.();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, notice, setError, setNotice, act, sync };
}
