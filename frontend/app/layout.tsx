import "./globals.css";
import type { Metadata } from "next";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Pulse",
  description: "Tell Pulse what you want. It handles the rest, within the limits you define.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <Providers>
          <div className="mx-auto max-w-lg px-4 py-8">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
