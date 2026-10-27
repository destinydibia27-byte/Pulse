import "@fontsource-variable/inter";
import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "./providers";
import { SiteHeader } from "./components/SiteHeader";
import { contractEventsUrl } from "../lib/explorer";
import Link from "next/link";

// Runs before first paint: use the saved choice, else the device setting. Keeps the page from
// flashing light when the person prefers dark.
const THEME_SCRIPT = `(function(){var t=null;try{t=localStorage.getItem("volo-theme")}catch(e){}if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)})();`;

export const metadata: Metadata = {
  title: { default: "Volo", template: "%s · Volo" },
  description: "Describe an onchain action in plain English, review the rules, and verify every transaction.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const contract = process.env.NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans">
        <Providers>
          <SiteHeader />
          <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">{children}</div>
          <footer className="mx-auto max-w-5xl px-4 pb-10 text-xs text-slate-600 sm:px-6">
            <p>
              <Link className="font-medium text-link hover:underline" href="/welcome">How Volo works</Link>
              {" · "}
              Volo is an unaudited testnet prototype on Arbitrum Sepolia. Do not use funds you cannot afford to lose.
              {contract && (
                <>
                  {" "}
                  <a className="font-medium text-link hover:underline" href={contractEventsUrl(contract)} target="_blank" rel="noopener noreferrer">
                    View the contract on Arbiscan
                  </a>
                  .
                </>
              )}
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
