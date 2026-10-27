import { NextResponse } from "next/server";
import { listAutomationsForUser, storageBackend } from "../../../lib/db";

// Never cached: an uptime monitor must reach the running server, and the database check must be real.
export const dynamic = "force-dynamic";

const LOW_GAS_WEI = 2_000_000_000_000_000n; // 0.002 ETH: a handful of runs left, time to top up

type ExecutorStatus = "ok" | "low-gas" | "wrong-key" | "unknown" | "not-configured";
let cached: { at: number; status: ExecutorStatus } | null = null;

/**
 * One wallet (the executor) sends every user's run and pays the gas. If it runs dry, or the key in
 * this server's settings is not the executor the contract trusts, every automation silently stops.
 * Cached for a minute so an uptime monitor does not turn into a stream of RPC calls.
 */
async function executorStatus(): Promise<ExecutorStatus> {
  if (cached && Date.now() - cached.at < 60_000) return cached.status;
  let status: ExecutorStatus = "unknown";
  try {
    if (!process.env.EXECUTOR_PRIVATE_KEY || !process.env.ARBITRUM_SEPOLIA_RPC_URL || !process.env.PULSE_CONTRACT_ADDRESS) {
      status = "not-configured";
    } else {
      const { executorAccountAddress, readContractExecutor, getPublicClient } = await import("../../../lib/chain");
      const mine = executorAccountAddress();
      const [onchain, balance] = await Promise.all([readContractExecutor(), getPublicClient().getBalance({ address: mine })]);
      status = onchain.toLowerCase() !== mine.toLowerCase() ? "wrong-key" : balance < LOW_GAS_WEI ? "low-gas" : "ok";
    }
  } catch {
    status = "unknown";
  }
  cached = { at: Date.now(), status };
  return status;
}

/**
 * Cheap health check for uptime monitors and for you after a deploy.
 * It reads the database once, so a 200 means the app is up AND can reach its storage.
 * "executor" tells you whether the shared sending wallet can actually run automations.
 * Responses are deliberately generic: no keys, URLs, addresses or internal error text.
 */
export async function GET() {
  let backend: "supabase" | "file" | "misconfigured" = "file";
  try {
    backend = storageBackend();
    await listAutomationsForUser("__health__");
    return NextResponse.json(
      { ok: true, storage: backend, executor: await executorStatus(), parser: process.env.GROQ_API_KEY?.trim() ? "llm" : "offline" },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[health] storage check failed:", (e as Error).message);
    return NextResponse.json(
      { ok: false, storage: backend, error: "storage unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
