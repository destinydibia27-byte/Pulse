"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  usePublicClient,
  useSignMessage,
} from "wagmi";
import { decodeEventLog, formatUnits } from "viem";
import { PULSE_ABI, ERC20_ABI } from "../../lib/abi";
import { PULSE_CONTRACT_ADDRESS } from "../../lib/wagmiConfig";
import { buildRegisterMessage } from "../../lib/auth";

type Phase = "checked" | "approving-usdc" | "creating-permission" | "recording" | "done";

export default function Review() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const [pending, setPending] = useState<any>(null);
  const [checkResult, setCheckResult] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("pulse.pendingIntent");
    if (!raw) {
      router.replace("/");
      return;
    }
    setPending(JSON.parse(raw));
  }, [router]);

  const maxPerWindowBig = useMemo(
    () => (checkResult ? BigInt(checkResult.policy.maxPerWindow) : 0n),
    [checkResult]
  );

  // Use the exact token the policy engine validated, so client and server can never drift.
  const asset = checkResult?.policy.asset as `0x${string}` | undefined;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: asset,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, PULSE_CONTRACT_ADDRESS] : undefined,
    query: { enabled: Boolean(address && checkResult) },
  });

  async function handleCheckRule() {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/policy-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "demo", intent: pending.intent, owner: address }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.reason);
        return;
      }
      setCheckResult(data);
      setPhase("checked");
    } finally {
      setChecking(false);
    }
  }

  async function handleApproveUsdc() {
    setError(null);
    setPhase("approving-usdc");
    try {
      const hash = await writeContractAsync({
        address: asset!,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PULSE_CONTRACT_ADDRESS, maxPerWindowBig],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
      await refetchAllowance();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPhase("checked");
    }
  }

  async function handleApprove() {
    setError(null);
    setPhase("creating-permission");
    try {
      const hash = await writeContractAsync({
        address: PULSE_CONTRACT_ADDRESS,
        abi: PULSE_ABI,
        functionName: "createPermission",
        args: [
          checkResult.policy.asset,
          checkResult.policy.recipient,
          BigInt(checkResult.policy.maxPerExecution),
          BigInt(checkResult.policy.maxPerWindow),
          BigInt(checkResult.policy.windowSeconds),
          BigInt(checkResult.policy.expiresAt),
          // The contract enforces these two itself, so a compromised worker cannot fire on the
          // wrong day or when the condition is unmet. Both come from the server's policy engine.
          checkResult.policy.weekday as number, // 0 = Sunday .. 6 = Saturday, UTC
          checkResult.policy.conditionOp as number, // Op enum: 0 GT, 1 GTE, 2 LT, 3 LTE, 4 EQ
          BigInt(checkResult.policy.conditionThreshold),
        ],
      });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });

      // Read the real permission id back from the emitted event. Never
      // invent or guess it client-side.
      let onchainId: bigint | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: PULSE_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "PermissionCreated") {
            onchainId = (decoded.args as any).id as bigint;
            break;
          }
        } catch {
          // not one of our events, skip
        }
      }
      if (onchainId === null) {
        throw new Error("Transaction succeeded but the PermissionCreated event was not found in the logs.");
      }

      setPhase("recording");
      // Prove control of `address` for this exact permission id. Expires in 5
      // minutes; the server rejects anything older or reused.
      const timestamp = Date.now();
      const registerSignature = await signMessageAsync({
        message: buildRegisterMessage(onchainId.toString(), address!, timestamp),
      });
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          onchainId: onchainId.toString(),
          // MVP limitation: rows are keyed by a fixed "demo" user, not the wallet address.
          userId: "demo",
          owner: address,
          // The server re-derives schedule, condition, amount and expiry from the intent
          // and checks them against the on-chain permission, so none are sent separately.
          intent: pending.intent,
          signature: registerSignature,
          timestamp,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.reason ?? "Failed to record automation.");

      sessionStorage.removeItem("pulse.pendingIntent");
      setPhase("done");
      router.push("/dashboard");
    } catch (e) {
      setError((e as Error).message);
      setPhase("checked");
    }
  }

  if (!pending) return null;
  const { intent, explanation } = pending;
  const needsAllowance = Boolean(checkResult) && (allowance ?? 0n) < maxPerWindowBig;

  return (
    <main className="space-y-6">
      <h1 className="text-xl font-semibold">Review automation</h1>

      <div className="card space-y-3">
        <p className="text-sm text-neutral-700">{explanation}</p>
        <div className="grid grid-cols-2 gap-2 text-xs text-neutral-500">
          <div>Trigger: every {intent.trigger.day} (UTC)</div>
          <div>Condition: {intent.condition.asset} {intent.condition.operator} ${intent.condition.balance}</div>
          <div>Action: send {intent.action.amount} {intent.action.asset}</div>
          <div>To: {intent.recipientId}</div>
          <div>Max/week: ${intent.maxPerWindow}</div>
          <div>Expires: {new Date(intent.expiresAt).toLocaleDateString()}</div>
        </div>
        <p className="text-xs text-neutral-500">
          Days are read in UTC, because the contract has no way to know your timezone. In some
          timezones that means a few hours of your local {intent.trigger.day} fall on the neighboring UTC day.
        </p>
        <div className="space-y-1 pt-2">
          <div className="pill">✓ Spending limit enforced</div>{" "}
          <div className="pill">✓ Recipient restricted</div>{" "}
          <div className="pill">✓ No unrestricted wallet access</div>{" "}
          <div className="pill">✓ Day and balance condition enforced on-chain</div>
        </div>
      </div>

      {!isConnected && (
        <p className="text-sm text-amber-600">Connect a wallet on the home screen before approving.</p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!checkResult ? (
        <button className="btn-primary" onClick={handleCheckRule} disabled={checking}>
          {checking ? "Checking…" : "Check rule"}
        </button>
      ) : (
        <div className="space-y-3">
          <div className="card space-y-2 text-sm">
            <p className="font-medium">
              {checkResult.ruleCheck.wellFormed ? "✓ Rule is well-formed" : "✗ Issues found"}
            </p>

            {checkResult.balanceCheck.status === "checked" ? (
              <div className="space-y-1">
                <p>
                  Your USDC balance right now:{" "}
                  <span className="font-medium">
                    {formatUnits(BigInt(checkResult.balanceCheck.balance), 6)}
                  </span>
                </p>
                <p
                  className={
                    checkResult.ruleCheck.currentConditionWouldPass
                      ? "text-green-700"
                      : "text-neutral-600"
                  }
                >
                  {checkResult.ruleCheck.currentConditionWouldPass
                    ? `✓ Your condition (USDC ${intent.condition.operator} $${intent.condition.balance}) is met right now.`
                    : `Your condition (USDC ${intent.condition.operator} $${intent.condition.balance}) isn't met right now. The automation would wait until it is.`}
                </p>
              </div>
            ) : (
              <p className="text-neutral-500">Balance not checked: {checkResult.balanceCheck.reason}</p>
            )}

            {checkResult.ruleCheck.warnings?.map((w: string) => (
              <p key={w} className="text-amber-600">⚠ {w}</p>
            ))}
            {checkResult.ruleCheck.issues?.map((i: string) => (
              <p key={i} className="text-red-600">{i}</p>
            ))}

            <p className="text-xs text-neutral-500">{checkResult.note}</p>
            <button className="pill" onClick={handleCheckRule} disabled={checking}>
              {checking ? "Checking…" : "Re-check"}
            </button>
          </div>

          {needsAllowance ? (
            <button
              className="btn-primary"
              onClick={handleApproveUsdc}
              disabled={!isConnected || phase === "approving-usdc"}
            >
              {phase === "approving-usdc" ? "Approving USDC…" : "1. Approve USDC spending"}
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={handleApprove}
              disabled={
                !isConnected ||
                !checkResult.ruleCheck.wellFormed ||
                phase === "creating-permission" ||
                phase === "recording"
              }
            >
              {phase === "creating-permission"
                ? "Signing permission…"
                : phase === "recording"
                ? "Recording…"
                : "2. Approve automation"}
            </button>
          )}
        </div>
      )}
    </main>
  );
}
