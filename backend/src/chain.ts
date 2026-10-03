import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { PULSE_ABI, ERC20_ABI } from "./abi";

/**
 * Thin wrapper around the PulseAutomation contract. The wallet used here
 * (EXECUTOR_PRIVATE_KEY) must match the `executor` address set on the
 * contract — it is ONLY authorized to call execute(), and execute() itself
 * re-checks every constraint on-chain. This key can trigger a call attempt;
 * it cannot move funds outside what a permission allows.
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Read-only client: needs only an RPC, never the executor key. */
export function getPublicClient() {
  const rpcUrl = requireEnv("ARBITRUM_SEPOLIA_RPC_URL");
  return createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
}

export function pulseAddress(): Address {
  return requireEnv("PULSE_CONTRACT_ADDRESS") as Address;
}

export async function readTokenBalanceOf(owner: Address, asset: Address): Promise<bigint> {
  return getPublicClient().readContract({
    address: asset, abi: ERC20_ABI, functionName: "balanceOf", args: [owner],
  });
}

export async function readAllowance(owner: Address, asset: Address): Promise<bigint> {
  return getPublicClient().readContract({
    address: asset, abi: ERC20_ABI, functionName: "allowance", args: [owner, pulseAddress()],
  });
}

export function executorAccountAddress(): Address {
  return privateKeyToAccount(requireEnv("EXECUTOR_PRIVATE_KEY") as `0x${string}`).address;
}

export async function readContractExecutor(): Promise<Address> {
  return getPublicClient().readContract({
    address: pulseAddress(), abi: PULSE_ABI, functionName: "executor",
  });
}

export function getClients() {
  const rpcUrl = requireEnv("ARBITRUM_SEPOLIA_RPC_URL");
  const contractAddress = requireEnv("PULSE_CONTRACT_ADDRESS") as Address;
  const executorKey = requireEnv("EXECUTOR_PRIVATE_KEY") as `0x${string}`;

  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });

  const account = privateKeyToAccount(executorKey);
  const walletClient = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });

  return { publicClient, walletClient, contractAddress, abi: PULSE_ABI };
}

export async function readPermission(id: bigint) {
  const { publicClient, contractAddress, abi } = getClients();
  return publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: "getPermission",
    args: [id],
  });
}

export type ExecutionOutcome =
  | { status: "success"; amount: bigint }
  | { status: "rejected"; reason: string }
  | { status: "reverted" }
  | { status: "unknown" };

/**
 * Attempts execution and reports what ACTUALLY happened.
 *
 * Important: PulseAutomation.execute() signals policy rejections (over cap,
 * paused, expired, wrong weekday, already run today, balance condition not met,
 * ...) by emitting ExecutionRejected and returning, NOT by reverting. The one thing that
 * DOES revert is the token transfer itself (owner balance or allowance too low), which rolls
 * the whole call back, so no state is consumed and a retry later is safe.
 * So a mined, receipt.status === "success" transaction can still be a rejection. Never treat "tx mined" as "funds moved" — read the events.
 */
/**
 * Thrown when a transaction WAS broadcast (we have its hash) but we never saw a
 * receipt. The transfer may or may not have happened, so callers must NOT retry
 * automatically; doing so could send twice.
 */
export class ExecutionUncertainError extends Error {
  constructor(public readonly hash: `0x${string}`, cause: unknown) {
    super(`Transaction ${hash} was sent but its confirmation was not received: ${(cause as Error)?.message ?? cause}`);
    this.name = "ExecutionUncertainError";
  }
}

export async function attemptExecution(id: bigint, amountBaseUnits: bigint) {
  const { publicClient, walletClient, contractAddress, abi } = getClients();

  // Pre-flight: an eth_call catches hard reverts (e.g. allowance/balance) for free,
  // before any gas is spent. It cannot see policy rejections (those don't revert).
  // Anything thrown here means nothing was sent, so it is safe to retry later.
  await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: "execute",
    args: [id, amountBaseUnits],
    account: walletClient.account,
  });

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi,
    functionName: "execute",
    args: [id, amountBaseUnits],
  });

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (err) {
    throw new ExecutionUncertainError(hash, err);
  }
  return { hash, receipt, outcome: readOutcome(receipt, contractAddress, id) };
}

export function readOutcome(
  receipt: { status: "success" | "reverted"; logs: readonly any[] },
  contractAddress: Address,
  id: bigint
): ExecutionOutcome {
  if (receipt.status === "reverted") return { status: "reverted" };

  const logs = parseEventLogs({
    abi: PULSE_ABI,
    logs: receipt.logs.filter(
      (l) => l.address.toLowerCase() === contractAddress.toLowerCase()
    ),
  });

  for (const log of logs) {
    if (log.eventName === "Executed" && log.args.id === id) {
      return { status: "success", amount: log.args.amount };
    }
    if (log.eventName === "ExecutionRejected" && log.args.id === id) {
      return { status: "rejected", reason: log.args.reason };
    }
  }
  return { status: "unknown" };
}

export async function cancelPermission(id: bigint, ownerWalletClient: ReturnType<typeof createWalletClient>) {
  const { contractAddress, abi } = getClients();
  return ownerWalletClient.writeContract({
    address: contractAddress,
    abi,
    functionName: "cancel",
    args: [id],
    chain: arbitrumSepolia,
    account: ownerWalletClient.account!,
  });
}

export interface ExpectedPermission {
  owner: Address;
  asset: Address;
  recipient: Address;
  maxPerExecution: bigint;
  maxPerWindow: bigint;
  windowSeconds: bigint;
  expiresAt: bigint;
  weekday: number; // 0 = Sunday .. 6 = Saturday, UTC
  conditionOp: number; // on-chain Op enum index
  conditionThreshold: bigint;
}

/** The positional tuple getPermission returns (see the field-order note in abi.ts). */
export type OnChainPermission = readonly [
  Address, Address, Address, bigint, bigint, bigint, bigint, bigint, bigint,
  number, number, number, bigint, bigint,
];

/**
 * Pure comparison of an on-chain permission against what the app believes it is. Split out
 * from the network read so every mismatch is unit-testable without a chain.
 */
export function checkPermissionMatches(
  p: OnChainPermission,
  expected: ExpectedPermission
): { ok: true } | { ok: false; reason: string } {
  const [
    owner, asset, recipient, maxPerExecution, maxPerWindow, windowSeconds, expiresAt,
    , , status, weekday, conditionOp, conditionThreshold,
  ] = p;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (eq(owner, "0x0000000000000000000000000000000000000000")) return { ok: false, reason: "No such permission on-chain." };
  if (!eq(owner, expected.owner)) return { ok: false, reason: "That permission belongs to a different wallet." };
  if (status !== 0) return { ok: false, reason: "That permission is not active on-chain." };
  if (!eq(asset, expected.asset)) return { ok: false, reason: "On-chain token does not match." };
  if (!eq(recipient, expected.recipient)) return { ok: false, reason: "On-chain recipient does not match." };
  if (maxPerExecution !== expected.maxPerExecution || maxPerWindow !== expected.maxPerWindow)
    return { ok: false, reason: "On-chain caps do not match." };
  if (windowSeconds !== expected.windowSeconds || expiresAt !== expected.expiresAt)
    return { ok: false, reason: "On-chain window or expiry does not match." };
  // The contract enforces these two now, so the app's record must describe exactly what the
  // chain will enforce, otherwise the dashboard and the worker would disagree with the chain.
  if (weekday !== expected.weekday) return { ok: false, reason: "On-chain weekday does not match." };
  if (conditionOp !== expected.conditionOp || conditionThreshold !== expected.conditionThreshold)
    return { ok: false, reason: "On-chain balance condition does not match." };
  return { ok: true };
}

/**
 * Confirms the on-chain permission is exactly what the app believes it is, so the
 * database never records a schedule for a permission that doesn't exist, isn't
 * active, or belongs to someone else. Read-only.
 */
export async function verifyPermissionOnChain(
  id: bigint,
  expected: ExpectedPermission
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const p = await getPublicClient().readContract({
    address: pulseAddress(), abi: PULSE_ABI, functionName: "getPermission", args: [id],
  });
  return checkPermissionMatches(p as OnChainPermission, expected);
}
