"use client";

import { ReactNode, useEffect, useRef } from "react";
import { addressUrl, shortAddr, shortHash, txUrl } from "../../lib/explorer";

export type Tone = "info" | "success" | "warning" | "danger" | "neutral";

const TONE: Record<Tone, string> = {
  info: "border-brand/25 bg-brand-soft text-brand-dark",
  success: "border-success/30 bg-success-soft text-green-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  danger: "border-red-300 bg-red-50 text-red-800",
  neutral: "border-slate-200 bg-slate-100 text-slate-700",
};

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  active: "success", paused: "warning", cancelled: "neutral", expired: "neutral",
  success: "success", rejected: "warning", error: "danger", submitted: "info",
};
const STATUS_LABEL: Record<string, string> = {
  success: "Sent", rejected: "Refused by contract", error: "Error", submitted: "Submitted",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  const dot = { success: "bg-success", warning: "bg-amber-500", danger: "bg-red-500", info: "bg-brand", neutral: "bg-slate-400" }[tone];
  return (
    <Badge tone={tone}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export function Alert({ tone = "info", title, children, className = "" }: {
  tone?: Tone; title?: string; children?: ReactNode; className?: string;
}) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-xl border p-3.5 text-sm ${TONE[tone]} ${className}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? "mt-1" : ""}>{children}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-12 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><circle cx="12" cy="12" r="3" />
        </svg>
      </div>
      <h3 className="mt-4 text-base font-semibold text-navy">{title}</h3>
      {children && <p className="mx-auto mt-1 max-w-sm text-sm text-slate-600">{children}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ExplorerLink({ kind, value, children }: { kind: "tx" | "address"; value: string; children?: ReactNode }) {
  return (
    <a
      href={kind === "tx" ? txUrl(value) : addressUrl(value)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-brand hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric"
    >
      <span className="font-mono text-[13px]">{children ?? (kind === "tx" ? shortHash(value) : shortAddr(value))}</span>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 17 17 7M8 7h9v9" />
      </svg>
      <span className="sr-only">(opens Arbiscan in a new tab)</span>
    </a>
  );
}

export function DetailRow({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-sm text-muted">
        {label}
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </dt>
      <dd className="min-w-0 break-words text-sm font-medium text-navy sm:text-right">{children}</dd>
    </div>
  );
}

/** Accessible confirmation for irreversible actions: Escape closes, focus starts on the safe choice. */
export function ConfirmDialog({
  open, title, children, confirmLabel, busyLabel = "Working…", cancelLabel = "Go back",
  tone = "danger", busy = false, onConfirm, onClose,
}: {
  open: boolean; title: string; children: ReactNode; confirmLabel: string; busyLabel?: string;
  cancelLabel?: string; tone?: "danger" | "primary"; busy?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const safeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    safeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy/60 p-4 sm:items-center" onClick={() => !busy && onClose()}>
      <div
        role="dialog" aria-modal="true" aria-labelledby="dialog-title"
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title" className="text-lg font-semibold text-navy">{title}</h2>
        <div className="mt-2 space-y-2 text-sm text-slate-600">{children}</div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={safeRef} className="btn-secondary" onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button className={tone === "danger" ? "btn-danger-solid" : "btn-primary"} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner />}{busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
