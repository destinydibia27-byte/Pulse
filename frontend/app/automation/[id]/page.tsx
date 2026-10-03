"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWriteContract, usePublicClient, useSignMessage } from "wagmi";
import { PULSE_ABI } from "../../../lib/abi";
import { PULSE_CONTRACT_ADDRESS } from "../../../lib/wagmiConfig";
import { buildActionMessage } from "../../../lib/auth";

export default function AutomationDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [automation, setAutomation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();

  async function load() {
    const res = await fetch("/api/automations?userId=demo");
    const data = await res.json();
    setAutomation((data.automations ?? []).find((a: any) => a.id === id));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function cancel() {
    if (!confirm("This permanently revokes the on-chain permission. Continue?")) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Revoke on-chain FIRST. The DB flag only flips after this confirms,
      //    so the UI can never claim "cancelled" while the authorization lives.
      const hash = await writeContractAsync({
        address: PULSE_CONTRACT_ADDRESS,
        abi: PULSE_ABI,
        functionName: "cancel",
        args: [BigInt(automation.onchainId)],
      });
      await publicClient!.waitForTransactionReceipt({ hash });

      // 2. Then record it, proving control of the owner wallet for this action.
      const timestamp = Date.now();
      const signature = await signMessageAsync({
        message: buildActionMessage(id, "cancel", timestamp),
      });
      await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "demo", automationId: id, action: "cancel", signature, timestamp }),
      });
      router.push("/dashboard");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!automation) return <p className="text-sm text-neutral-500">Loading…</p>;

  return (
    <main className="space-y-6">
      <h1 className="text-xl font-semibold">{automation.label}</h1>

      <div className="card space-y-2 text-sm">
        <Row label="Status" value={automation.status} />
        <Row label="Recipient" value={automation.recipientLabel} />
        <Row label="Amount / execution" value={automation.amountBaseUnits} />
        <Row label="Created" value={new Date(automation.createdAt).toLocaleString()} />
        {automation.lastExecution && (
          <>
            <Row label="Last execution status" value={automation.lastExecution.status} />
            <Row label="Detail" value={automation.lastExecution.txHash ?? automation.lastExecution.reason ?? automation.lastExecution.error ?? "—"} />
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        className="btn-secondary border-red-300 text-red-600"
        onClick={cancel}
        disabled={busy || automation.status === "cancelled"}
      >
        {busy ? "Revoking on-chain…" : "Cancel automation"}
      </button>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-neutral-100 pb-1 last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
