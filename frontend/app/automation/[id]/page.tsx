"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
import { PULSE_CONTRACT_ADDRESS } from "../../../lib/wagmiConfig";
import { OPERATORS, WEEKDAYS, contractEventsUrl, formatDateTime, shortAddr, utcDayToDate } from "../../../lib/explorer";
import { Alert, ConfirmDialog, DetailRow, EmptyState, ExplorerLink, Spinner, StatusBadge } from "../../components/ui";
import { useAutomationActions } from "../../components/useAutomationActions";
import { useOnchainPermission } from "../../components/useOnchain";

const USDC = (v: string | bigint) => formatUnits(BigInt(v), 6);

export default function AutomationDetail() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const router = useRouter();

  const [automation, setAutomation] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/automations?userId=demo");
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const found = ((await res.json()).automations ?? []).find((a: any) => a.id === id);
      setAutomation(found ?? null);
      setNotFound(!found);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id]);

  const actions = useAutomationActions(load);
  const { permission, isError: chainUnavailable, refetch: refetchChain } = useOnchainPermission(automation?.onchainId);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: automation?.asset,
    abi: erc20Abi,
    functionName: "allowance",
    args: automation?.owner ? [automation.owner, PULSE_CONTRACT_ADDRESS] : undefined,
    query: { enabled: Boolean(automation?.asset && automation?.owner && PULSE_CONTRACT_ADDRESS) },
  });

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (permission) refetchChain(); /* re-read after the app record changes */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automation?.status]);

  if (loadError) {
    return <EmptyState title="Could not load this automation" action={<button className="btn-secondary" onClick={load}>Try again</button>}>{loadError}</EmptyState>;
  }
  if (notFound) {
    return <EmptyState title="Automation not found" action={<Link href="/dashboard" className="btn-primary">Back to dashboard</Link>}>It may have been removed, or it belongs to a different data file.</EmptyState>;
  }
  if (!automation) return <div className="card h-64 animate-pulse" aria-label="Loading" />;

  const chain = permission?.status;
  const status = chain ?? automation.status;
  const mismatch = chain && chain !== automation.status ? chain : null;
  const syncAction = mismatch === "cancelled" ? "cancel" : mismatch === "paused" ? "pause" : mismatch === "active" ? "resume" : null;
  const working = actions.busy && actions.busy.id === automation.id ? actions.busy.action : null;
  const history: any[] = [...(automation.history?.length ? automation.history : automation.lastExecution ? [automation.lastExecution] : [])].reverse();
  const amount = automation.amountBaseUnits ? BigInt(automation.amountBaseUnits) : null;
  const allowanceLow = status === "active" && allowance !== undefined && amount !== null && allowance < amount;
  const needsRenewal = (status === "active" || status === "paused") && allowance !== undefined && permission !== undefined && allowance < permission.maxPerWindow;
  const isOwner = address && automation.owner && address.toLowerCase() === String(automation.owner).toLowerCase();
  const spentPct = permission && permission.maxPerWindow > 0n ? Number((permission.spentInWindow * 100n) / permission.maxPerWindow) : 0;

  async function revokeApproval() {
    setRevokeError(null);
    if (!isOwner) { setRevokeError(`Connect the owner wallet (${shortAddr(automation.owner)}) to revoke its approval.`); setConfirmRevoke(false); return; }
    setRevoking(true);
    try {
      const hash = await writeContractAsync({
        address: automation.asset, abi: erc20Abi, functionName: "approve", args: [PULSE_CONTRACT_ADDRESS, 0n],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
      await refetchAllowance();
    } catch (e) {
      setRevokeError((e as Error).message.split("\n")[0]);
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  }

  /** Same approval the review step asks for: up to the weekly cap, nothing more. */
  async function renewApproval() {
    setRevokeError(null);
    if (!isOwner) { setRevokeError(`Connect the owner wallet (${shortAddr(automation.owner)}) to renew its approval.`); return; }
    if (!permission) return;
    setRenewing(true);
    try {
      const hash = await writeContractAsync({
        address: automation.asset, abi: erc20Abi, functionName: "approve", args: [PULSE_CONTRACT_ADDRESS, permission.maxPerWindow],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
      await refetchAllowance();
    } catch (e) {
      setRevokeError((e as Error).message.split("\n")[0]);
    } finally {
      setRenewing(false);
    }
  }

  /** The contract cannot edit a permission, so "edit" means: start a new rule from this one, then cancel this. */
  function copyAsNew() {
    const word = ({ ">": "above", ">=": "at least", "<": "below", "<=": "at most", "==": "exactly" } as Record<string, string>)[automation.condition.operator] ?? "above";
    const day = automation.trigger.day.charAt(0).toUpperCase() + automation.trigger.day.slice(1);
    const text = `Every ${day}, send $${USDC(amount as bigint)} to my ${automation.recipientLabel} wallet when my balance is ${word} $${USDC(automation.condition.thresholdBaseUnits)}.`;
    sessionStorage.setItem("volo.prefill", text);
    router.push("/");
  }

  async function doCancel() {
    await actions.act(automation, "cancel");
    setConfirmCancel(false);
  }

  return (
    <main>
      <Link href="/dashboard" className="btn-ghost -ml-3">← Dashboard</Link>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">Automation</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-navy sm:text-3xl">{automation.label}</h1>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <StatusBadge status={status} />
          <span className="text-xs text-slate-600">{chain ? "status read from the contract" : chainUnavailable ? "contract status unavailable right now" : "app record"}</span>
        </div>
      </div>

      {mismatch && (
        <Alert tone="warning" title="The app and the contract disagree" className="mt-5">
          The app&apos;s record says <b>{automation.status}</b>; the contract says <b>{mismatch}</b>. The contract is what counts.
          {syncAction && (
            <button className="mt-2 block font-semibold underline" disabled={Boolean(working)} onClick={() => actions.sync(automation, syncAction)}>
              {working === "sync" ? "Updating…" : "Update the app's record"}
            </button>
          )}
        </Alert>
      )}
      {actions.error && <Alert tone="danger" className="mt-5">{actions.error}</Alert>}
      {actions.notice && <Alert tone="info" className="mt-5">{actions.notice}</Alert>}
      {status === "cancelled" && (
        <Alert tone="info" title="This permission is permanently revoked" className="mt-5">
          The contract will refuse every run. Your USDC approval is a separate setting that stays in place until you revoke it below.
        </Alert>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <section className="card" aria-labelledby="rules">
            <h2 id="rules" className="text-base font-semibold text-navy">Rules</h2>
            <dl className="mt-2">
              <DetailRow label="Sends">{amount !== null ? `${USDC(amount)} USDC` : "—"} to {automation.recipientLabel}</DetailRow>
              {automation.trigger && (
                <DetailRow label="When">Every {WEEKDAYS[permission?.weekday ?? WEEKDAYS.findIndex((d) => d.toLowerCase() === automation.trigger.day)]} (UTC), at most once per day</DetailRow>
              )}
              {automation.condition && (
                <DetailRow label="Condition">USDC balance {automation.condition.operator} ${USDC(automation.condition.thresholdBaseUnits)} when the run happens</DetailRow>
              )}
              <DetailRow label="Created">{new Date(automation.createdAt).toLocaleString()}</DetailRow>
              <DetailRow label="Expires">{new Date(automation.expiresAt * 1000).toLocaleDateString()}</DetailRow>
            </dl>
          </section>

          <section className="card" aria-labelledby="onchain">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="onchain" className="text-base font-semibold text-navy">What the contract enforces</h2>
                <p className="text-xs text-muted">Read live from the contract, not from the app&apos;s records.</p>
              </div>
              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => refetchChain()}>Refresh</button>
            </div>
            {permission ? (
              <dl className="mt-2">
                <DetailRow label="Wallet it can use">{<ExplorerLink kind="address" value={permission.owner} />}</DetailRow>
                <DetailRow label="Only sends to"><ExplorerLink kind="address" value={permission.recipient} /></DetailRow>
                <DetailRow label="Max per run">{USDC(permission.maxPerExecution)} USDC</DetailRow>
                <DetailRow label="Max per week">{USDC(permission.maxPerWindow)} USDC</DetailRow>
                <DetailRow label="Used this week">
                  <span className="block">{USDC(permission.spentInWindow)} of {USDC(permission.maxPerWindow)} USDC</span>
                  <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-surface sm:ml-auto sm:w-40" role="progressbar" aria-valuenow={spentPct} aria-valuemin={0} aria-valuemax={100} aria-label="Weekly spending used">
                    <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(100, spentPct)}%` }} />
                  </span>
                </DetailRow>
                <DetailRow label="Runs on">{WEEKDAYS[permission.weekday]} (UTC), once per day</DetailRow>
                <DetailRow label="Balance condition">USDC {OPERATORS[permission.conditionOp]} ${USDC(permission.conditionThreshold)}</DetailRow>
                <DetailRow label="Expires">{new Date(Number(permission.expiresAt) * 1000).toLocaleDateString()}</DetailRow>
                <DetailRow label="Last successful send">{utcDayToDate(permission.lastExecutionDay) ?? "Never"}</DetailRow>
                <DetailRow label="Contract"><ExplorerLink kind="address" value={PULSE_CONTRACT_ADDRESS} /></DetailRow>
              </dl>
            ) : chainUnavailable ? (
              <Alert tone="warning" className="mt-3">Could not read the contract right now. Try Refresh.</Alert>
            ) : (
              <div className="mt-3 space-y-2" aria-label="Loading"><div className="h-4 w-2/3 animate-pulse rounded bg-surface" /><div className="h-4 w-1/2 animate-pulse rounded bg-surface" /></div>
            )}
          </section>

          <section className="card" aria-labelledby="history">
            <h2 id="history" className="text-base font-semibold text-navy">Execution history</h2>
            {history.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">Nothing has run yet. When it does, each result appears here with its transaction.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs text-muted">{formatDateTime(h.at)}</p>
                      {(h.reason || h.error) && <p className="text-sm text-slate-700">{h.reason ?? h.error}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <StatusBadge status={h.status} />
                      {h.txHash && <ExplorerLink kind="tx" value={h.txHash} />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {PULSE_CONTRACT_ADDRESS && (
              <p className="mt-3 text-xs text-slate-600">
                To check independently, open the contract&apos;s{" "}
                <a className="font-semibold text-brand hover:underline" href={contractEventsUrl(PULSE_CONTRACT_ADDRESS)} target="_blank" rel="noopener noreferrer">event log on Arbiscan</a>.
              </p>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <section className="card" aria-labelledby="approval">
            <h2 id="approval" className="text-base font-semibold text-navy">USDC approval</h2>
            <p className="mt-1 text-sm text-slate-600">
              The contract can only move your USDC through this approval, and each run uses part of it up.
            </p>
            <dl className="mt-2">
              <DetailRow label="Approval remaining">{allowance !== undefined ? `${USDC(allowance)} USDC` : "—"}</DetailRow>
              {amount !== null && <DetailRow label="Next run needs">{USDC(amount)} USDC</DetailRow>}
            </dl>
            {allowanceLow && (
              <Alert tone="warning" className="mt-3">
                The approval is smaller than one run, so the next run will fail until you renew it.
              </Alert>
            )}
            {revokeError && <Alert tone="danger" className="mt-3">{revokeError}</Alert>}
            {needsRenewal && permission && (
              <>
                <button className="btn-primary mt-4 w-full" disabled={renewing || revoking} onClick={renewApproval}>
                  {renewing && <Spinner />}{renewing ? "Waiting for your wallet…" : `Renew approval (${USDC(permission.maxPerWindow)} USDC)`}
                </button>
                <p className="mt-2 text-xs text-slate-600">Approves your weekly cap again, and nothing more. Your wallet asks you to confirm.</p>
              </>
            )}
            <button
              className="btn-danger mt-4 w-full"
              disabled={revoking || allowance === undefined || allowance === 0n}
              onClick={() => setConfirmRevoke(true)}
            >
              Revoke USDC approval
            </button>
            {allowance === 0n && <p className="mt-2 text-xs text-muted">Nothing is approved, so there is nothing to revoke.</p>}
          </section>

          <section className="card" aria-labelledby="manage">
            <h2 id="manage" className="text-base font-semibold text-navy">Manage</h2>
            <div className="mt-3 space-y-3">
              {status === "active" && (
                <button className="btn-secondary w-full" disabled={Boolean(working)} onClick={() => actions.act(automation, "pause")}>
                  {working === "pause" && <Spinner />}{working === "pause" ? "Pausing on-chain…" : "Pause (you can resume later)"}
                </button>
              )}
              {status === "paused" && (
                <button className="btn-secondary w-full" disabled={Boolean(working)} onClick={() => actions.act(automation, "resume")}>
                  {working === "resume" && <Spinner />}{working === "resume" ? "Resuming on-chain…" : "Resume"}
                </button>
              )}
              <p className="text-xs text-slate-600">
                Rules cannot be edited in place. Start a changed copy, then cancel this one once the new one is active.
              </p>
              {automation.trigger && automation.condition && amount !== null && (
                <button className="btn-secondary w-full" onClick={copyAsNew}>Create a changed copy</button>
              )}
            </div>

            <div className="mt-5 rounded-xl border border-red-200 bg-red-50/50 p-4">
              <p className="text-sm font-semibold text-red-800">Danger zone</p>
              <p className="mt-1 text-xs text-red-900/80">Cancelling permanently revokes this permission on the contract. It cannot be resumed.</p>
              <button className="btn-danger mt-3 w-full" disabled={Boolean(working) || status === "cancelled"} onClick={() => setConfirmCancel(true)}>
                {status === "cancelled" ? "Already cancelled" : "Cancel automation"}
              </button>
            </div>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this automation permanently?"
        confirmLabel="Cancel permanently"
        busyLabel="Revoking on-chain…"
        busy={working === "cancel"}
        onConfirm={doCancel}
        onClose={() => setConfirmCancel(false)}
      >
        <p>This sends a transaction that revokes the permission on the contract. It cannot be undone or resumed.</p>
        <p>Your USDC approval is separate and stays until you revoke it. Your wallet will ask you to confirm twice: the transaction, then a signature.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke your USDC approval?"
        confirmLabel="Revoke approval"
        busyLabel="Revoking…"
        busy={revoking}
        onConfirm={revokeApproval}
        onClose={() => setConfirmRevoke(false)}
      >
        <p>This sets the contract&apos;s spending approval on your wallet to zero.</p>
        <p><b>It applies to all of your Volo automations</b>, not only this one. Any that are still active will fail until you approve again.</p>
      </ConfirmDialog>
    </main>
  );
}
