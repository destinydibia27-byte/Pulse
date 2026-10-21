"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo } from "./Logo";
import { WalletButton } from "./WalletButton";

const NAV = [
  { href: "/", label: "Automate" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/activity", label: "Activity" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/review") : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Volo home" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric">
          <Logo />
        </Link>
        <span className="hidden rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-slate-600 sm:inline">
          Arbitrum Sepolia · testnet
        </span>

        <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric ${
                isActive(n.href) ? "bg-brand-soft text-brand-dark" : "text-slate-600 hover:bg-surface hover:text-navy"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <WalletButton />
          <button
            className="btn-secondary !px-2.5 !py-2 md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <nav id="mobile-nav" aria-label="Main" className="border-t border-line bg-white px-4 py-3 md:hidden">
          <ul className="space-y-1">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  onClick={() => setOpen(false)}
                  aria-current={isActive(n.href) ? "page" : undefined}
                  className={`block rounded-lg px-3 py-2.5 text-sm font-semibold ${
                    isActive(n.href) ? "bg-brand-soft text-brand-dark" : "text-slate-700 hover:bg-surface"
                  }`}
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-3 px-3 text-xs text-muted">Arbitrum Sepolia testnet</p>
        </nav>
      )}
    </header>
  );
}
