# How Volo is built

This page is for anyone (or any AI assistant) who needs to understand the code quickly.

## The one idea

A person types a sentence. Volo turns it into a small, fixed rule, shows exactly what it understood, and only after the person approves in their wallet does a **smart contract** hold the permission. The AI never has spending power. It fills in a form; code checks the form; the contract enforces the limits.

```
sentence ──► AI reader ──► checked rule ──► person reviews ──► wallet approves ──► contract holds permission
 (chat)     (parser.ts)   (policyEngine)    (Review page)      (approve + create)       │
                                                                                        ▼
                                                              worker wakes up on schedule ──► contract.execute()
                                                              (triggerWorker.ts)              (re-checks every rule)
```

Three layers, each distrusting the one before it:

1. **The AI reader** (`backend/src/parser.ts`) turns text into JSON. Its output is untrusted.
2. **The app's checks** (`schema.ts`, `parser.ts` grounding, `policyEngine.ts`) refuse anything that is not a well-formed rule built from what the person actually wrote.
3. **The contract** (`contracts/src/PulseAutomation.sol`) enforces recipient, caps, expiry, weekday, once-per-day and the balance condition on every run, no matter who calls it.

## What happens, step by step

| Step | Where | What it does |
|---|---|---|
| 1. Chat | `frontend/app/page.tsx` | Person types. If Volo asked a question, a short answer is joined onto the earlier sentence (`followUp.ts`). |
| 2. Read | `POST /api/parse` → `parser.ts` | AI reader (Groq) or the offline fallback returns JSON. Then the **grounding check** compares it to the person's own words: amount, balance, weekday and recipient must really be in the text, and amount and balance must not be swapped. Numbers are understood in any form (`$1k`, "ten", "a hundred") via `numbers.ts`. |
| 3. Check | `POST /api/policy-check` → `policyEngine.ts` | Resolves the recipient **label** ("savings") to the address *this user* saved in Settings, applies caps and expiry, reads the on-chain balance, and returns what will be enforced. |
| 4. Review | `frontend/app/review/page.tsx` | Shows the exact rule. The person approves: USDC `approve` + contract `createPermission`, both signed in their wallet. |
| 5. Register | `POST /api/automations` | The wallet signs a message; the server verifies it, reads the permission back from the chain, and only stores the record if the chain agrees. |
| 6. Run | `backend/src/triggerWorker.ts` | One process polls every 60s, decides *when to attempt*, and calls the contract. It persists "intent to send" before sending (at-most-once). The contract still re-checks everything. |
| 7. Manage | Dashboard / detail page | Pause, resume, cancel are wallet transactions; the app's record then follows the chain. |

## Where things live

```
contracts/src/PulseAutomation.sol   the on-chain rules (Foundry tests in contracts/test)
backend/src/                        all logic that is not UI. The tests in backend/test cover it.
  schema.ts          the one rule shape (zod); unknown fields are dropped, bad ones rejected
  parser.ts          prompt, AI call contract, grounding check, expiry default
  numbers.ts         finds numbers however written ("$1k", "ten", "a hundred")
  followUp.ts        joins a short answer onto the earlier sentence
  recipients.ts      label and address rules for a user's saved recipients
  policyEngine.ts    rule -> enforceable policy (caps, expiry, recipient lookup)
  scheduler.ts       pure "is it due?" logic (weekday, once per day, retries)
  db.ts              storage: Supabase when configured, otherwise a JSON file
  chain.ts / abi.ts  talking to the contract and token
  auth.ts            wallet-signature messages and verification
  nonceGuard.ts      stops a signed request being replayed
  rateLimit.ts       per-visitor and global request limits
  triggerWorker.ts   the scheduler process
frontend/app/        Next.js pages and API routes (api/parse, policy-check, automations, recipients, execute, health)
frontend/lib/        COPIES of the shared backend files (see below) plus a few frontend-only files
supabase/schema.sql  the two tables
scripts/             sync-shared.sh, start-hosted.sh
```

**Shared code is copied.** The files listed in `scripts/sync-shared.sh` are edited in `backend/src` and copied to `frontend/lib`. After editing one, run `bash scripts/sync-shared.sh`. `bash scripts/sync-shared.sh --check` fails if they drifted.

## Rules the code never breaks

- The AI never sees wallets, keys or addresses. A pasted address is refused before the AI is called, and the AI is told never to output one. A recipient is only ever a **label**; the address comes from the user's own saved list.
- Every write is signed by the wallet that owns the thing being changed, with a time window and replay protection.
- A user is their wallet address. Records are filed under it, and a rule can only use the recipients saved by the wallet that is making it.
- The worker sends nothing unless it has first recorded that it is about to.
- Provider error text never reaches the browser, only the server log.

## Settings (environment variables)

Secrets are server-side only. Anything starting with `NEXT_PUBLIC_` is visible in the browser.

| Name | Needed | Purpose |
|---|---|---|
| `ARBITRUM_SEPOLIA_RPC_URL` | yes | Server and worker connection to the chain |
| `NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL` | yes | Browser connection (use a public URL) |
| `PULSE_CONTRACT_ADDRESS`, `NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS` | yes | The deployed contract (same value twice) |
| `EXECUTOR_PRIVATE_KEY` | yes | The wallet that sends runs and pays their gas. Secret. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | one storage option | Use both or neither. Secret key stays server-side. |
| `PULSE_DB_PATH` | with no Supabase | JSON file shared by the app and the worker |
| `GROQ_API_KEY` | for the AI reader | Without it Volo uses a basic offline reader |
| `GROQ_MODEL`, `GROQ_BASE_URL`, `LLM_TIMEOUT_MS` | no | Default `openai/gpt-oss-120b`, Groq's URL, 25000 |
| `MAX_AUTOMATIONS_PER_OWNER` | no | Default 10 |
| `RATE_LIMIT_SCALE` | no | Multiplies every request limit. Default 1 |
| `ENABLE_DEMO_FIRE` | no | `true` shows a "run now" button. Keep `false` on a public site |
| `POLL_INTERVAL_MS` | no | Worker poll period, default 60000 |
| `NEXT_PUBLIC_USDC_ADDRESS` | no | Override the test USDC address |

(`PULSE_` is the old project name. The names are kept so existing deployments keep working.)

## Checking your work

```
cd contracts && forge test        # contract
cd backend  && npm test           # all logic (parser, grounding, storage, auth, scheduler...)
bash scripts/sync-shared.sh --check
cd frontend && npm run build      # types, lint, pages
```

`backend/e2e-multiuser.mts` drives a running server with two wallets (instructions at the top of the file).

## Known limits (testnet prototype)

- Unaudited contract. Arbitrum Sepolia test tokens only.
- One shared executor key sends every user's runs, so its gas balance and secrecy matter. `/api/health` reports `executor: ok | low-gas | wrong-key`.
- One worker process. If it is down, runs do not happen.
- Saved recipients are readable by anyone who knows a wallet address; add wallet sign-in sessions before real money.
- Rate limits identify visitors by proxy headers (spoofable), which is why each route also has a global ceiling.
