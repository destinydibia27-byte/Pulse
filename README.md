# Pulse — MVP scaffold

## Live deployment (Arbitrum Sepolia, testnet only)

- **Contract:** [`0x9E73A83F09434530Fe860D758EE923C711E05273`](https://sepolia.arbiscan.io/address/0x9E73A83F09434530Fe860D758EE923C711E05273)
- Its **Transactions** tab shows the full loop that was run on a real chain: contract deployment,`createPermission`, automatic executions sent by the worker, and a pause and cancel.
- Test USDC: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (Circle's Arbitrum Sepolia USDC)

### What was demonstrated on-chain

| Step | Result |
|---|---|
| Plain-English rule parsed to a fixed schema and reviewed | "Every Friday (UTC), if USDC > $1, send $1 to savings" |
| Permission created on-chain | capped amount, locked recipient, expiry, weekday, balance condition |
| Execution without a human click | the worker found the rule due and the contract paid it |
| Repeat attempt the same day | refused by the contract: "Already executed for this UTC day" |
| Pause, then cancel | on-chain status read 0 (active), then 1 (paused), then 2 (cancelled) |

### Honest limitations

- Pulse enforces permissions with its **own contract**, not a smart-account provider (ZeroDev, Safe). Composing with a provider is the v2 path.
- The contract is **unaudited** and for testnet only. Do not use real funds.
- The trigger-watcher is a **single process** (a single point of failure for liveness, not safety): if it is down, nothing runs, but the contract still refuses anything outside the rules.
- Schedules are in **UTC**, because the chain has no source of a user's timezone.

This is a working scaffold for the hackathon MVP described in `pulse-build-prompt.md`:
intent → rule → safety → check → approval → automation → execution → revocation,
targeting Arbitrum Sepolia / USDC.

It's structured so the core loop runs **today, offline, with zero config** (mocked
LLM parsing, mocked chain calls), and upgrades to **real on-chain execution** by
setting three env vars — nothing else changes.

## What's real vs. mocked right now

| Piece | Status |
|---|---|
| Intent schema + validation (`lib/schema.ts`) | Real. Rejects anything that doesn't fit — no partial trust. |
| Policy engine (`lib/policyEngine.ts`) | Real logic. Recipient allowlist is hardcoded for `demo` user — wire to a real settings table before shipping. |
| "Check rule" balance read (`lib/balance.ts`) | Real. The server reads the connected wallet's USDC balance over `ARBITRUM_SEPOLIA_RPC_URL` and compares it to the condition threshold and the send amount. Verified against a local chain with a real token and the real route (rich/poor/unmet/no-wallet/bad-address/RPC-down cases). If the wallet isn't connected or the RPC is unset/down it says "balance not checked" and explains why; it never guesses. Informational only: it cannot block approval or grant authority. |
| Smart contract (`contracts/src/PulseAutomation.sol`) | 60 Foundry tests pass (incl. fuzz) and a local Anvil end-to-end run passes through the real backend code. Unaudited. **Not yet deployed to Arbitrum Sepolia** (needs your funded deployer key). |
| `/api/parse` | Real endpoint. Uses Groq (OpenAI-compatible chat completions, `llama-3.3-70b-versatile` by default) if `GROQ_API_KEY` is set; otherwise a keyword-based mock parser so the UI is demoable offline. |
| `/api/execute` | Real endpoint. Makes an actual on-chain `execute()` call if `ARBITRUM_SEPOLIA_RPC_URL` / `PULSE_CONTRACT_ADDRESS` / `EXECUTOR_PRIVATE_KEY` are set; otherwise runs in **MOCK MODE** (clearly labeled in the API response) so you can demo the loop's shape without a live deployment. |
| Trigger worker (`backend/src/triggerWorker.ts`, `npm run worker`) | Real. Checks the schedule (read in UTC, to match the contract) and your balance condition, and sends at most once per day. Persists its intent before sending so a crash can't cause a double send. Retries only failures where nothing was sent (3/day, 5-min backoff). Verified end to end against a live local chain. **Still a single process and a single point of failure**; the production path is a keeper network (Chainlink Automation / Gelato). |
| Wallet-signature auth (`lib/auth.ts`, `lib/nonceGuard.ts`) | Real. Every registration and every pause/resume/cancel/fire requires a fresh signature (EIP-191 personal_sign) from the wallet that actually owns the automation — verified by recovering the signer locally, no RPC needed. Each signature works once (5-minute window) and is bound to the exact action and id, so a captured request can't be replayed or repurposed. Verified directly against the real route handlers: forged signer, wrong action, stale timestamp, replay, and missing fields all correctly rejected (401/400/409); valid requests succeed. |
| Registration (`/api/automations`) | Derives schedule/condition/amount/expiry server-side from the validated intent and, when a chain is configured, reads the permission back from the chain and refuses anything that doesn't match exactly (wrong owner, wrong caps, inactive, nonexistent). |
| Wallet connect + user-signed `createPermission()` | Wired (wagmi injected wallet). Flow: check rule → approve USDC allowance if needed → sign `createPermission()` → real permission id read from the `PermissionCreated` event → recorded. Pause/resume/cancel also sign on-chain first and only update the DB after the tx confirms. **Untested against a live chain until the contract is deployed.** |

## Repo layout

```
contracts/
  src/PulseAutomation.sol  the on-chain permission contract
  test/                    Foundry tests
  script/Deploy.s.sol      deploy script
  script/local-e2e.sh      local Anvil end-to-end check
backend/
  src/schema.ts            fixed intent shape + strict validation
  src/parser.ts             LLM call -> validated intent
  src/policyEngine.ts       recipient allowlist + cap checks + "check rule"
  src/chain.ts               viem helpers for create/execute/pause/cancel
  src/triggerWorker.ts       MVP placeholder poller (explicitly not production)
  src/db.ts                  JSON-file store, never touches private keys
frontend/
  app/page.tsx                       Home
  app/review/page.tsx                Rule review + "Check rule" (not "Simulate")
  app/dashboard/page.tsx             Active automations
  app/automation/[id]/page.tsx       Detail + real Cancel
  app/api/parse/route.ts             text -> validated intent
  app/api/policy-check/route.ts      policy resolution + rule check
  app/api/automations/route.ts       list/create
  app/api/execute/route.ts           fire/pause/resume/cancel
  lib/                               copies of backend/src/{schema,parser,policyEngine,chain,db}.ts
                                      (duplicated for a self-contained Next.js app —
                                      extract to a shared package before this grows further)
```

## Setup

```bash
cp .env.example .env       # fill in what you have; all vars are optional for the offline demo

cd frontend
npm install
npm run dev                # http://localhost:3000
```

That alone gets you the full clickable loop: type a request → review → check rule →
approve → dashboard → fire trigger (mock) → cancel.

### To make it real

See "Going live on Arbitrum Sepolia" further down for the full walkthrough (wallets, faucets, `npm run check`). Short version:

1. **Deploy the contract.** Set up Foundry or Hardhat in `contracts/`, install
   OpenZeppelin (`npm install @openzeppelin/contracts`), deploy
   `PulseAutomation.sol` to Arbitrum Sepolia with the executor address you
   control. Fill `PULSE_CONTRACT_ADDRESS` and `ARBITRUM_SEPOLIA_RPC_URL`.
2. **Fund and set `EXECUTOR_PRIVATE_KEY`** — this wallet needs a small amount
   of Sepolia ETH for gas. It can only call `execute()`; it never holds funds.
3. **Set the browser-side vars** `NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS` and `NEXT_PUBLIC_USDC_ADDRESS` (same values as the server-side ones). Without them the wallet flow has no contract to talk to.
4. **Set `GROQ_API_KEY`** (and optionally `GROQ_MODEL`) for real intent parsing instead of the keyword mock.
5. **Confirm the USDC address on-chain.** It now defaults to Circle's documented
   Arbitrum Sepolia USDC (`frontend/lib/constants.ts`, single source of truth,
   validated at startup). Run once against your RPC:
   `cd backend && ARBITRUM_SEPOLIA_RPC_URL=... npx tsx scripts/verify-usdc.ts`
   It checks chain id, contract code, `symbol()==USDC` and `decimals()==6`.
6. **Set `DEMO_SAVINGS_ADDRESS`** to a wallet you control. The fallback is a public
   Anvil address that anyone can spend from (fine for valueless testnet tokens only).

## Security notes carried over from the spec

- The AI only ever outputs into the fixed schema in `lib/schema.ts`. Anything
  that doesn't validate is rejected, never coerced — see `IntentValidationError`.
- `execute()` on the contract re-checks status, expiration, the weekday (UTC),
  once-per-UTC-day, the balance condition, the per-execution cap, and the weekly
  cap on every call, regardless of who calls it or what the backend "thinks" is
  true. The backend/worker can only decide *when to try* `execute()`, never
  *whether it's allowed*. (It can still fail to try at all; see the worker note below.)
- "Check rule" (frontend + `policyEngine.checkRule`) validates the policy now;
  it is explicitly not a prediction of state at the future trigger time. Don't
  relabel it "Simulate" without also changing what it actually checks.
- `db.ts` never stores private keys or seed phrases. Custody lives in the
  user's wallet / the executor's own key, not in the JSON store.

## How the worker decides (plain-language rules)

- **"Every Friday"** means Friday **in UTC**, because the contract enforces the weekday itself and has no way to know your timezone. The review screen says "(UTC)". In Lagos that differs from local time by one hour at the edge of the day.
- On that day it checks your USDC balance and allowance. It sends the **first time** your condition holds that day, then not again until next week. If the condition isn't met yet, it keeps checking that day.
- It **never sends twice for one day.** If it crashes mid-send, or a sent transaction is never confirmed, it does *not* resend automatically; it records the transaction hash for you to check. It would rather miss a run than risk paying twice.
- If nothing was sent (RPC error, pre-flight simulation failed), it retries after 5 minutes, up to 3 times that day, then waits for the next scheduled day.
- If the contract rejects a run (e.g. cap reached), that's final for the day and the on-chain reason is shown on the dashboard. The worker's own checks mirror the contract's, so rejections should be rare; they exist to avoid wasting gas, not to provide safety.
- A transfer that **reverts** (your balance or allowance dropped between the check and the send) is different from a rejection: nothing moved and nothing was used up, so the worker retries.
- The web app and the worker are separate processes and **must share one database file**: set `PULSE_DB_PATH` for both. Run **exactly one** worker.

```bash
cd backend && npm install
ARBITRUM_SEPOLIA_RPC_URL=... PULSE_CONTRACT_ADDRESS=... EXECUTOR_PRIVATE_KEY=... PULSE_DB_PATH=... npm run worker
```
On start it refuses to run if the RPC isn't Arbitrum Sepolia, or if `EXECUTOR_PRIVATE_KEY` isn't the address the contract trusts as executor.

## Going live on Arbitrum Sepolia — step by step

One `.env` file at the repo root now covers everything (the frontend, the worker,
and every script load it automatically; a real environment variable always wins
over the file).

```bash
cp .env.example .env   # then fill it in as you go through the steps below
```

1. **Get two wallets.** One to deploy (`DEPLOYER_PRIVATE_KEY`, used once, not stored
   in `.env`), one to be the executor (`EXECUTOR_PRIVATE_KEY`, stays running). Any
   EOA works — `cast wallet new` (Foundry) or MetaMask's "create account" both do.
   Use throwaway keys. Never reuse a key that holds real funds.

2. **Fund the executor with a little Sepolia ETH for gas.** It doesn't need much.
   Arbitrum's official faucet list is at https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info
   — Alchemy's (`alchemy.com/faucets/arbitrum-sepolia`) and QuickNode's are common
   no-signup options that drip ~0.1 ETH/day. If a faucet asks for mainnet ETH/activity
   as an anti-bot check, that's normal for some of them.

3. **Get an RPC URL.** A free tier from Alchemy or Infura is enough — create an app,
   pick Arbitrum Sepolia, copy the HTTPS URL into `ARBITRUM_SEPOLIA_RPC_URL`.

4. **Deploy the contract** (see `contracts/README.md` for the full command):
   ```bash
   cd contracts
   forge install OpenZeppelin/openzeppelin-contracts@v5.0.2 foundry-rs/forge-std --no-git
   EXECUTOR_ADDRESS=<executor address> forge script script/Deploy.s.sol:Deploy \
     --rpc-url $ARBITRUM_SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
   ```
   Put the printed address in `.env` as **both** `PULSE_CONTRACT_ADDRESS` and
   `NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS` (they must match — the browser and the
   server otherwise talk to different contracts).

5. **Set `DEMO_SAVINGS_ADDRESS`** to a wallet you actually control. The fallback is
   a public Anvil test address anyone can spend from.

6. **Get testnet USDC for the wallet you'll connect in the browser**, not the
   executor: Circle's public faucet at https://faucet.circle.com (10 USDC/day,
   no account) or the Developer Console faucet (20/day, needs a free Circle
   account) — both support Arbitrum Sepolia directly.

7. **Run the all-in-one check** — this replaces manually re-checking each piece:
   ```bash
   cd backend && npm install && npm run check
   ```
   It tells you exactly what's missing or mismatched (wrong executor key, RPC on
   the wrong chain, no contract at that address, bad token, unfunded executor,
   `NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS` not matching the server one) before you
   hit it mid-transaction. Fix everything it marks FAIL; WARN items are optional
   for a first test. Re-run it after every change until it says "Setup looks good."

8. **Start the app and the worker** (two terminals):
   ```bash
   cd frontend && npm install && npm run dev
   cd backend  && npm run worker
   ```

9. **Do one real run by hand first**, before waiting on the schedule: connect your
   wallet in the browser, create a rule with a condition you already meet, approve
   it, then use "Run now (demo)" on the dashboard rather than waiting for the
   worker's next scheduled day. **The contract enforces the schedule, so "Run now"
   only succeeds on the rule's weekday (UTC) and while the balance condition holds;
   otherwise you get the contract's refusal and its reason.** For a demo, create
   the rule for today's UTC weekday. Confirm the transaction on
   https://sepolia.arbiscan.io before trusting the worker's automatic runs.

10. **Only then let the worker run unattended**, and check back on it — see
    "Known limitations" above for what it won't tell you if it silently stops.

## How the web app gets its settings

`npm run dev`, `npm run build` and `npm run start` in `frontend/` go through
`frontend/scripts/run-with-env.js`, which loads the repo-root `.env` into the environment
before Next starts and prints which key settings are missing (names only). Do not call
`next start` directly: with only a root `.env` file, the API routes then do not see it. The
symptoms are "No server RPC configured" and, worse, the "savings" recipient silently falling back
to the public demo address. The review screen now shows the recipient address and warns if it is
that public address. The backend worker reads the same `.env` itself, but only when started from
the `backend/` folder.

## Testing

```bash
cd backend && npm install && npm test          # 87 tests: decimals, operators, rule check, schema/injection boundary, on-chain weekday/operator mapping, ABI-vs-Solidity drift guards, permission verification, scheduler (timezones, DST, year rollover), worker (once-a-day, crash safety, retries)
cd ../contracts && forge test                   # 60 contract tests (see contracts/README.md)
bash contracts/script/local-e2e.sh              # real backend code vs a real local contract
bash contracts/script/local-full.sh             # full stack: contract + web app + signed, on-chain-verified registration + the worker + manual fire (29 checks)
scripts/sync-shared.sh --check                  # fails if frontend/lib copies drifted from backend/src
```

## Known limitations (current)

- **Authentication is signature-based, not session-based.** Every write requires a fresh wallet signature, but there's still no login/session layer — `userId` in requests is just a database lookup key, not itself a trusted identity (the signature check is what's trusted, and it's verified against the record's actual on-chain `owner`, never against `userId`).
- **Replay guard is in-memory and single-process.** It resets on restart and doesn't work across multiple server instances. Fine for one deployment; move to a shared store (Redis, a DB table) before running more than one instance.
- **EOA wallets only.** Signature verification is local EIP-191 recovery. A smart-contract wallet (Safe, etc.) as an automation's owner would need ERC-1271 verification instead, which needs an RPC call — not implemented.
- Set `ENABLE_DEMO_FIRE=false` on any deployment other people can reach: "Run now (demo)" still lets the automation's real owner trigger a run early (it's authenticated now, just not something you may want exposed).
- **JSON file database.** Writes are atomic and serialized within a process, but the web app and worker are two processes doing read-modify-write, so an update can occasionally be lost. Fine for a demo; use SQLite/Postgres before anything real.
- **Schedules are in UTC**, not local time (the browser's timezone is no longer used). The contract has no source of a user's timezone, so a UTC weekday is the only thing it can enforce.

- **"Check rule" reads the balance only if a wallet is connected and the server has an RPC.** Otherwise it says so. It's a snapshot of *now*; it can't predict the balance when the automation actually triggers. The wallet address comes from the browser, which is fine because it's only used to read a public balance.

- **Single demo user.** DB rows and the approved-recipient list are keyed by the fixed string `"demo"`, not by wallet address. Any connected wallet writes into the same bucket. Key by address before any multi-user use.
- **USDC address is confirmed against Circle's docs, not against the chain.** This sandbox can't reach Arbitrum Sepolia, so `verify-usdc.ts`'s success path hasn't been run. Run it once.
- **Wallet flow untested on-chain.** It typechecks and builds, but has not been run against a deployed contract. Expect to debug the first real run.
- **`next build` needs the alias in `next.config.js`.** wagmi's connector barrel pulls in optional Coinbase/x402 dependencies we don't use; they're stubbed out there. Don't remove it unless you also install those packages.
- **Schedule and balance condition are now enforced on-chain** (weekday in UTC, once per UTC day, balance condition), so a compromised worker can no longer send on the wrong day or when the condition is unmet. It can still fail to send at all (single point of failure). See `contracts/README.md`.
- **Fixed-window cap**, not sliding: up to 2x the cap can move around a window boundary. Windows start at 00:00 UTC (so the first window can be up to a day short), which keeps a weekday schedule from being refused for sending earlier in the day than last week.
