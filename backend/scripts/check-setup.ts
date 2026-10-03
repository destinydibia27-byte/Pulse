/**
 * One command that tells you exactly what's wrong with your setup, BEFORE you hit it
 * inside a transaction:    cd backend && npm run check
 *
 * Read-only. Never prints secrets. Exits 1 if anything is a hard failure.
 */
import path from "path";
import { createPublicClient, http, isAddress, getAddress, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { PULSE_ABI } from "../src/abi";

const DEFAULT_USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const PUBLIC_ANVIL_RECIPIENT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

type Level = "ok" | "warn" | "fail";
const rows: { level: Level; msg: string }[] = [];
const say = (level: Level, msg: string) => rows.push({ level, msg });

async function main() {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), "..", ".env"));
  } catch {
    say("warn", "No .env file found at the repo root; using only the real environment.");
  }
  const env = process.env;

  // ---- 1. required variables, present and well-formed ----
  const need = ["ARBITRUM_SEPOLIA_RPC_URL", "PULSE_CONTRACT_ADDRESS", "NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS", "EXECUTOR_PRIVATE_KEY"];
  const missing = need.filter((k) => !env[k]);
  for (const k of missing) say("fail", `${k} is not set.`);

  const contract = env.PULSE_CONTRACT_ADDRESS;
  if (contract && !isAddress(contract)) say("fail", `PULSE_CONTRACT_ADDRESS is not a valid address (${contract.length - 2} hex chars, need 40).`);
  if (contract && env.NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS && contract.toLowerCase() !== env.NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS.toLowerCase())
    say("fail", "NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS differs from PULSE_CONTRACT_ADDRESS; the browser and server would talk to different contracts.");

  const key = env.EXECUTOR_PRIVATE_KEY;
  let executor: `0x${string}` | undefined;
  if (key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) say("fail", "EXECUTOR_PRIVATE_KEY is not a 0x + 64 hex character key.");
    else executor = privateKeyToAccount(key as `0x${string}`).address;
  }

  // ---- 2. optional but important ----
  if (!env.GROQ_API_KEY) say("warn", "GROQ_API_KEY is not set: intent parsing will use the crude offline keyword parser, not the LLM.");
  const savings = env.DEMO_SAVINGS_ADDRESS;
  if (!savings) say("warn", "DEMO_SAVINGS_ADDRESS is not set: 'savings' will point at a PUBLIC test address anyone can spend from. Set it to a wallet you control.");
  else if (!isAddress(savings)) say("fail", "DEMO_SAVINGS_ADDRESS is not a valid address.");
  else if (savings.toLowerCase() === PUBLIC_ANVIL_RECIPIENT.toLowerCase()) say("warn", "DEMO_SAVINGS_ADDRESS is the public Anvil test address; anyone can spend from it.");
  else say("ok", `Savings recipient is ${getAddress(savings)}.`);

  // ---- 3. the chain ----
  const rpc = env.ARBITRUM_SEPOLIA_RPC_URL;
  if (rpc && contract && isAddress(contract)) {
    const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc, { timeout: 10_000, retryCount: 1 }) });
    try {
      const chainId = await client.getChainId();
      if (chainId !== arbitrumSepolia.id) {
        say("fail", `RPC is chain ${chainId}, expected Arbitrum Sepolia (${arbitrumSepolia.id}).`);
      } else {
        say("ok", "RPC reachable and is Arbitrum Sepolia.");

        const code = await client.getCode({ address: getAddress(contract) });
        if (!code || code === "0x") say("fail", `No contract at ${contract} on this chain. Did the deploy succeed, and is this the right address?`);
        else {
          say("ok", "Pulse contract found.");
          if (executor) {
            const onChain = await client.readContract({ address: getAddress(contract), abi: PULSE_ABI, functionName: "executor" });
            if (onChain.toLowerCase() !== executor.toLowerCase())
              say("fail", `EXECUTOR_PRIVATE_KEY controls ${executor}, but the contract's executor is ${onChain}. Every run would fail. Redeploy with EXECUTOR_ADDRESS=${executor}, or use the matching key.`);
            else say("ok", `Executor key matches the contract's executor (${executor}).`);
          }
        }

        if (executor) {
          const bal = await client.getBalance({ address: executor });
          if (bal === 0n) say("fail", `Executor ${executor} has 0 ETH; it cannot pay gas. Fund it from a faucet.`);
          else if (bal < 1_000_000_000_000_000n) say("warn", `Executor has only ${formatEther(bal)} ETH; top it up if runs start failing.`);
          else say("ok", `Executor has ${formatEther(bal)} ETH for gas.`);
        }

        const usdc = env.NEXT_PUBLIC_USDC_ADDRESS || DEFAULT_USDC;
        if (!isAddress(usdc)) say("fail", `USDC address "${usdc}" is not a valid address.`);
        else {
          const abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
          const ucode = await client.getCode({ address: getAddress(usdc) });
          if (!ucode || ucode === "0x") say("fail", `No USDC contract at ${usdc} on this chain.`);
          else {
            const [sym, dec] = await Promise.all([
              client.readContract({ address: getAddress(usdc), abi, functionName: "symbol" }),
              client.readContract({ address: getAddress(usdc), abi, functionName: "decimals" }),
            ]);
            if (sym !== "USDC" || dec !== 6) say("fail", `Token at ${usdc} reports symbol "${sym}" and ${dec} decimals; Pulse needs USDC with 6.`);
            else say("ok", "USDC token looks right (symbol USDC, 6 decimals).");
          }
        }
      }
    } catch {
      // Deliberately not printing the error: RPC URLs often embed API keys.
      say("fail", "Could not talk to the RPC. Check ARBITRUM_SEPOLIA_RPC_URL (and your internet connection).");
    }
  }

  // ---- report ----
  const icon = { ok: "PASS", warn: "WARN", fail: "FAIL" } as const;
  for (const r of rows) console.log(`${icon[r.level]}  ${r.msg}`);
  const fails = rows.filter((r) => r.level === "fail").length;
  const warns = rows.filter((r) => r.level === "warn").length;
  console.log(`\n${fails === 0 ? "Setup looks good." : "Fix the FAIL items above."} (${fails} failed, ${warns} warnings)`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(() => {
  console.error("Setup check crashed unexpectedly.");
  process.exit(1);
});
