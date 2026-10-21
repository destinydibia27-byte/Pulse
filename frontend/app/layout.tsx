import "@fontsource-variable/inter";
import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "./providers";
import { SiteHeader } from "./components/SiteHeader";
import { contractEventsUrl } from "../lib/explorer";

export const metadata: Metadata = {
  title: { default: "Volo", template: "%s · Volo" },
  description: "Describe an onchain action in plain English, review the rules, and verify every transaction.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const contract = process.env.NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS;
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <Providers>
          <SiteHeader />
          <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">{children}</div>
          <footer className="mx-auto max-w-5xl px-4 pb-10 text-xs text-slate-600 sm:px-6">
            <p>
              Volo is an unaudited testnet prototype on Arbitrum Sepolia. Do not use funds you cannot afford to lose.
              {contract && (
                <>
                  {" "}
                  <a className="font-medium text-brand hover:underline" href={contractEventsUrl(contract)} target="_blank" rel="noopener noreferrer">
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
