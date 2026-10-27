/** Frontend-only helpers: explorer links and number/date formatting. No secrets, no network. */
export const EXPLORER_BASE = "https://sepolia.arbiscan.io"; // the app is configured for Arbitrum Sepolia only
export const NETWORK_NAME = "Arbitrum Sepolia";
export const txUrl = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER_BASE}/address/${addr}`;
export const contractEventsUrl = (addr: string) => `${EXPLORER_BASE}/address/${addr}#events`;
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const OPERATORS = [">", ">=", "<", "<=", "=="] as const; // index = contract Op enum
const NEVER = 2n ** 256n - 1n;

/** The contract records the last successful send as a UTC day index; this turns it into a date. */
export function utcDayToDate(day: bigint): string | null {
  if (day === NEVER) return null;
  return new Date(Number(day) * 86_400_000).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
