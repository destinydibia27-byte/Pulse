"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  usePublicClient,
  useSignMessage,
} from "wagmi";
import { decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, parseUnits } from "viem";
import { PULSE_ABI, ERC20_ABI } from "../../lib/abi";
import { PULSE_CONTRACT_ADDRESS } from "../../lib/wagmiConfig";
import { buildRegisterMessage } from "../../lib/auth";
import { shortAddr } from "../../lib/explorer";
import { Alert, DetailRow, ExplorerLink, Spinner } from "../components/ui";
import { useActiveAccount } from "../components/useActiveAccount";

type Phase = "checked" | "approving-usdc" | "creating-permission" | "recording" | "done";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Review() {
  const router = useRouter();
  const active = useActiveAccount();
  const { eoa: address, connected: isConnected, smart, isSmart: useSmart } = active;
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  // "smart" = a gasless ZeroDev smart account owns the permission and holds the USDC;
  // "wallet" = the connected wallet does. The choice lives in Settings (see useActiveAccount).
  const ownerAddr = active.address as `0x${string}` | undefined;
  const [fundAmount, setFundAmount] = useState("");
  const [funding, setFunding] = useState(false);

  const [pending, setPending] = useState<any>(null);
  const [checkResult, setCheckResult] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

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
    args: ownerAddr ? [ownerAddr, PULSE_CONTRACT_ADDRESS] : undefined,
    query: { enabled: Boolean(ownerAddr && checkResult) },
  });

  const { data: smartBalance, refetch: refetchSmartBalance } = useReadContract({
    address: asset,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: smart.address ? [smart.address] : undefined,
    query: { enabled: Boolean(useSmart && smart.address && asset) },
  });

  async function handleCheckRule() {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/policy-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: pending.intent, owner: ownerAddr }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.reason);
        return;
      }
      setCheckResult(data);
      setPhase("checked");
    } catch (e) {
      setError(`Could not check the rule: ${(e as Error).message}`);
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

  /** Sends USDC from the connected wallet to the smart account. This one is a normal transaction (needs a little ETH). */
  async function handleFund() {
    setError(null);
    if (!smart.address || !asset) return;
    let amount: bigint;
    try {
      amount = parseUnits(fundAmount.trim(), 6);
      if (amount <= 0n) throw new Error();
    } catch {
      setError("Enter how much USDC to send to the smart account, for example 25.");
      return;
    }
    setFunding(true);
    try {
      const hash = await writeContractAsync({ address: asset, abi: erc20Abi, functionName: "transfer", args: [smart.address, amount] });
      await publicClient!.waitForTransactionReceipt({ hash });
      await refetchSmartBalance();
      setFundAmount("");
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    } finally {
      setFunding(false);
    }
  }

  async function handleApprove() {
    setError(null);
    setPhase("creating-permission");
    try {
      const createArgs = [
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
      ] as const;

      let receipt;
      if (useSmart) {
        if (!smart.address) throw new Error("The smart account is not ready yet.");
        // One sponsored UserOperation: the USDC approval (only if still needed) and the permission,
        // both made BY the smart account, so it is the permission's owner.
        const calls = [];
        if (needsAllowance) {
          calls.push({
            to: asset!,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PULSE_CONTRACT_ADDRESS, maxPerWindowBig] }),
          });
        }
        calls.push({
          to: PULSE_CONTRACT_ADDRESS,
          data: encodeFunctionData({ abi: PULSE_ABI, functionName: "createPermission", args: createArgs }),
        });
        ({ receipt } = await smart.send(calls));
      } else {
        const hash = await writeContractAsync({
          address: PULSE_CONTRACT_ADDRESS,
          abi: PULSE_ABI,
          functionName: "createPermission",
          args: createArgs,
        });
        receipt = await publicClient!.waitForTransactionReceipt({ hash });
      }

      // Read the real permission id back from the emitted event. Never
      // invent or guess it client-side.
      let onchainId: bigint | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== PULSE_CONTRACT_ADDRESS.toLowerCase()) continue;
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
      const registerMessage = buildRegisterMessage(onchainId.toString(), ownerAddr!, timestamp);
      const registerSignature = await active.sign(registerMessage);
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          onchainId: onchainId.toString(),
          owner: ownerAddr,
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
      router.push("/dashboard?created=1");
    } catch (e) {
      setError((e as Error).message);
      setPhase("checked");
    }
  }

  if (!pending) return null;
  const { intent, explanation } = pending;
  const needsAllowance = Boolean(checkResult) && (allowance ?? 0n) < maxPerWindowBig;
  const recipientAddr = checkResult?.policy?.recipient as string | undefined;
  const separateApproval = needsAllowance && !useSmart; // a smart account folds the approval into the one activation
  const step = !checkResult ? 1 : separateApproval ? 2 : 3;
  const smartBalanceText = smartBalance !== undefined ? formatUnits(smartBalance as bigint, 6) : "…";
  const working = phase === "approving-usdc" || phase === "creating-permission" || phase === "recording";
  const STEPS = ["Check the rule", "Approve USDC", "Activate"];

  return (
    <main>
      <Link href="/" className="btn-ghost -ml-3">← Change description</Link>
      <p className="eyebrow mt-2">Review</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight text-navy">Review before you activate</h1>
      <p className="mt-2 max-w-2xl text-slate-600">
        Nothing exists yet. Check the rules and the permissions below. The automation only becomes real after you approve in your wallet.
      </p>

      <ol className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" aria-label="Progress">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step || phase === "done";
          const current = n === step && phase !== "done";
          return (
            <li key={label} className="flex items-center gap-2" aria-current={current ? "step" : undefined}>
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-success text-white" : current ? "bg-brand text-white" : "bg-card text-muted ring-1 ring-line"}`} aria-hidden="true">
                {done ? "✓" : n}
              </span>
              <span className={current ? "font-semibold text-navy" : "text-slate-600"}>{label}</span>
              {n < STEPS.length && <span className="hidden text-line sm:inline" aria-hidden="true">—</span>}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {pending.parser === "offline" && (
            <Alert tone="warning" title="Read in offline mode">
              No AI model is configured, so Volo used a simple fallback that picks out numbers, a weekday and a recipient.
              It cannot tell &ldquo;above&rdquo; from &ldquo;below&rdquo; and always assumes &ldquo;above&rdquo;. Check every field below before approving.
            </Alert>
          )}

          <section className="card" aria-labelledby="understood">
            <h2 id="understood" className="text-base font-semibold text-navy">What Volo understood</h2>
            <p className="mt-2 text-sm text-slate-700">{explanation}</p>
            <dl className="mt-3">
              <DetailRow label="When">Every {cap(intent.trigger.day)} (UTC), at most once per day</DetailRow>
              <DetailRow label="Condition">{intent.condition.asset} balance {intent.condition.operator} ${intent.condition.balance} when it runs</DetailRow>
              <DetailRow label="Action">Send {intent.action.amount} {intent.action.asset}</DetailRow>
              <DetailRow label="To">
                {intent.recipientId}
                {recipientAddr && <> · <ExplorerLink kind="address" value={recipientAddr} /></>}
              </DetailRow>
              <DetailRow label="Max per run">${intent.maxPerExecution}</DetailRow>
              <DetailRow label="Max per week">${intent.maxPerWindow}</DetailRow>
              <DetailRow label="Expires">{new Date(intent.expiresAt).toLocaleDateString()}</DetailRow>
            </dl>
            
            <p className="mt-3 text-xs text-slate-600">
              Days are read in UTC because the contract has no way to know your timezone. In some timezones a few hours of your
              local {cap(intent.trigger.day)} fall on the neighboring UTC day.
            </p>
          </section>

          {!isConnected && <Alert tone="warning">Connect a wallet (top right) before you approve.</Alert>}

          {useSmart && isConnected && (
            <section className="card" aria-label="Account">
              {smart.loading && <p className="text-sm text-slate-600">Preparing your smart account…</p>}
              {smart.error && <Alert tone="danger" title="Could not prepare the smart account">{smart.error}</Alert>}
              {smart.address && (
                <p className="text-sm text-slate-700">
                  Running from your smart account <ExplorerLink kind="address" value={smart.address} />, with gas paid for you. USDC in it:{" "}
                  <span className="font-semibold">{smartBalanceText}</span>.{" "}
                  <Link href="/settings" className="font-semibold text-link underline">Change account</Link>
                </p>
              )}
            </section>
          )}
          {error && (
            <Alert tone="danger" title="That did not work">
              {error}
              {/pre-approved recipient/i.test(error) && (
                <>
                  {" "}
                  <Link href="/settings" className="font-semibold underline">Save this recipient in Settings</Link>, then check the rule again.
                </>
              )}
            </Alert>
          )}

          {!checkResult ? (
            <section className="card" aria-labelledby="check">
              <h2 id="check" className="text-base font-semibold text-navy">Check the rule</h2>
              <p className="mt-1 text-sm text-slate-600">
                Checks that the rule is well-formed and compares it with your wallet as it is right now. It does not predict your future balance.
              </p>
              <button className="btn-primary mt-4" onClick={handleCheckRule} disabled={checking || (useSmart && !smart.address)}>
                {checking && <Spinner />}{checking ? "Checking…" : "Check rule"}
              </button>
            </section>
          ) : (
            <>
              <section className="card" aria-labelledby="result">
                <h2 id="result" className="text-base font-semibold text-navy">Rule check</h2>
                <p className={`mt-2 text-sm font-semibold ${checkResult.ruleCheck.wellFormed ? "text-green-700" : "text-red-700"}`}>
                  {checkResult.ruleCheck.wellFormed ? "✓ The rule is well-formed" : "✗ Issues found"}
                </p>
                {checkResult.balanceCheck.status === "checked" ? (
                  <div className="mt-2 space-y-1 text-sm">
                    <p>
                      Your USDC balance right now:{" "}
                      <span className="font-semibold">{formatUnits(BigInt(checkResult.balanceCheck.balance), 6)}</span>
                    </p>
                    <p className={checkResult.ruleCheck.currentConditionWouldPass ? "text-green-700" : "text-slate-600"}>
                      {checkResult.ruleCheck.currentConditionWouldPass
                        ? `✓ Your condition (USDC ${intent.condition.operator} $${intent.condition.balance}) is met right now.`
                        : `Your condition (USDC ${intent.condition.operator} $${intent.condition.balance}) isn't met right now. The automation would wait until it is.`}
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-600">Balance not checked: {checkResult.balanceCheck.reason}</p>
                )}
                {checkResult.ruleCheck.warnings?.map((w: string) => <p key={w} className="mt-1 text-sm text-amber-700">⚠ {w}</p>)}
                {checkResult.ruleCheck.issues?.map((i: string) => <p key={i} className="mt-1 text-sm text-red-700">{i}</p>)}
                <p className="mt-3 text-xs text-slate-600">{checkResult.note}</p>
                <button className="btn-secondary mt-3 !py-1.5" onClick={handleCheckRule} disabled={checking}>
                  {checking && <Spinner />}{checking ? "Checking…" : "Re-check"}
                </button>
              </section>

              <section className="card" aria-labelledby="activate">
                <h2 id="activate" className="text-base font-semibold text-navy">{separateApproval ? "Approve USDC spending" : "Activate"}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  {useSmart
                    ? `One gasless transaction${needsAllowance ? " approves up to " + formatUnits(maxPerWindowBig, 6) + " USDC (your weekly cap) and" : ""} creates the permission from your smart account, then you sign once to record it in the app.`
                    : separateApproval
                    ? `Step 1 of 2. This lets the Volo contract move up to ${formatUnits(maxPerWindowBig, 6)} USDC from your wallet, your weekly cap, and nothing more. It is a token approval on-chain.`
                    : "Step 2 of 2. This creates the permission on-chain with the limits above, then records it in the app. Your wallet will ask you to confirm twice: a transaction, then a signature."}
                </p>
                {allowance !== undefined && (
                  <p className="mt-1 text-xs text-muted">Currently approved for this contract: {formatUnits(allowance as bigint, 6)} USDC.</p>
                )}
                {useSmart && smart.address && (
                  <div className="mt-3 rounded-xl border border-line p-3 text-sm">
                    <p className="font-semibold text-navy">Fund the smart account</p>
                    <p className="mt-1 text-slate-600">
                      The automation spends USDC held by the smart account, not by your wallet. It has {smartBalanceText} USDC now.
                      Sending from your wallet is a normal transaction, so it needs a little ETH for gas.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        inputMode="decimal"
                        placeholder="USDC amount"
                        value={fundAmount}
                        onChange={(e) => setFundAmount(e.target.value)}
                        className="w-36 rounded-lg border border-line px-3 py-1.5 text-sm"
                        aria-label="USDC amount to send to the smart account"
                      />
                      <button className="btn-secondary !py-1.5" onClick={handleFund} disabled={funding || working}>
                        {funding && <Spinner />}{funding ? "Sending…" : "Send USDC to smart account"}
                      </button>
                    </div>
                  </div>
                )}
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 text-sm text-navy">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-line accent-brand focus-visible:ring-2 focus-visible:ring-electric"
                  />
                  <span>I have reviewed the rules and the permissions on this page, and I understand the limits listed on the right.</span>
                </label>
                {separateApproval ? (
                  <button className="btn-primary mt-4" onClick={handleApproveUsdc} disabled={!isConnected || !confirmed || working}>
                    {phase === "approving-usdc" && <Spinner />}
                    {phase === "approving-usdc" ? "Waiting for your wallet…" : "1. Approve USDC spending"}
                  </button>
                ) : (
                  <button
                    className="btn-primary mt-4"
                    onClick={handleApprove}
                    disabled={!isConnected || !confirmed || !checkResult.ruleCheck.wellFormed || working || (useSmart && !smart.address)}
                  >
                    {working && <Spinner />}
                    {phase === "creating-permission" ? (useSmart ? "Sending (gasless)…" : "Waiting for your wallet…") : phase === "recording" ? "Recording…" : useSmart ? "Activate automation (gasless)" : "2. Activate automation"}
                  </button>
                )}
              </section>
            </>
          )}
        </div>

        <aside className="space-y-6">
          <section className="card" aria-labelledby="perms">
            <h2 id="perms" className="text-base font-semibold text-navy">Permissions you are granting</h2>
            <dl className="mt-2">
              <DetailRow label="Wallet it can use">{ownerAddr ? <span className="font-mono text-[13px]">{shortAddr(ownerAddr)}{useSmart ? " (smart account)" : ""}</span> : useSmart && smart.loading ? "Preparing smart account…" : "Connect a wallet"}</DetailRow>
              <DetailRow label="What it can do">Send {intent.action.asset} only. No other transaction type.</DetailRow>
              <DetailRow label="Only sends to">{recipientAddr ? <ExplorerLink kind="address" value={recipientAddr} /> : `${intent.recipientId} (shown after the check)`}</DetailRow>
              <DetailRow label="Spending limits">${intent.maxPerExecution} per run, ${intent.maxPerWindow} per week</DetailRow>
              <DetailRow label="Only runs when">{cap(intent.trigger.day)} (UTC), and USDC {intent.condition.operator} ${intent.condition.balance}</DetailRow>
              <DetailRow label="Expires">{new Date(intent.expiresAt).toLocaleDateString()}</DetailRow>
              <DetailRow label="How to stop it">Pause (reversible) or cancel (permanent) from the dashboard, and revoke the USDC approval.</DetailRow>
            </dl>
            <p className="mt-3 rounded-lg bg-success-soft px-3 py-2 text-xs text-green-900">
              Enforced by the contract on every run: the recipient, both limits, the day, once per day, the balance condition and the expiry. The app and the worker cannot override them.
            </p>
          </section>

          <section className="card" aria-labelledby="limits">
            <h2 id="limits" className="text-base font-semibold text-navy">What this does not protect</h2>
            <ul className="mt-2 list-disc space-y-2 pl-4 text-sm text-slate-700">
              <li>The contract caps each run but does not fix the exact amount. The worker chooses an amount up to the per-run limit.</li>
              <li>Your USDC approval equals your weekly cap and is used up as runs send. When it runs out, runs fail until you approve again.</li>
              <li>Nothing guarantees a run happens. The worker is a single process; if it is down, nothing is sent.</li>
              <li>Volo is an unaudited testnet prototype. Do not use funds you cannot afford to lose.</li>
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
