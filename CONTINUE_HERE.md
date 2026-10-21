# Pulse: current state

The in-progress work from the previous handoff (moving the weekday and balance
condition on-chain) is **finished and verified locally**. Nothing has been deployed
to Sepolia, and nothing here has touched a live chain.

## What changed

- **Contract** (`contracts/src/PulseAutomation.sol`): enforces weekday (UTC), once
  per UTC day, and the balance condition in `execute()`. `createPermission` takes
  9 arguments. Check order: status, weekday, once-per-day, condition, amount/caps.
  A rejected or reverted attempt never uses up the day.
- **Contract tests**: 60 pass. The old harness failures are fixed (see below).
- **ABI, policy engine, registration route, review page, fire route, worker docs**
  updated for the 9-argument signature. `frontend/lib` is in sync with `backend/src`.
- **`local-e2e.sh` and `local-full.sh`** rewritten for the new rules. `local-full.sh`
  was *already broken before this change*: it sent unsigned requests to routes that
  require wallet signatures. It now signs every write with `cast wallet sign`.

## Verified (all run for real, not just typechecked)

| Check | Result |
|---|---|
| `forge test` | 91 pass (60 + 31 price tests; green with the optimizer on and off, up to 5,000 fuzz runs) |
| Mutation test of the weekday, once-per-day, condition and window checks | 42/42 caught on the previous contract; after the v2 refactor 12 of them re-run and caught |
| Mutation test of the new price logic | 29/29 mutants caught |
| `backend` `npm test` | 96 pass (includes ABI-vs-Solidity drift guards for the new function, struct and event) |
| `backend` / `frontend` `tsc --noEmit`, `next build` | clean |
| `scripts/sync-shared.sh --check` | in sync |
| `contracts/script/local-e2e.sh` | all checks pass, including price met / unmet / stale / feed down on a real chain with mock feeds |
| `contracts/script/local-full.sh` | 29 passed, 0 failed |

## Decisions worth knowing about

1. **Schedules are UTC, always.** The contract cannot know a timezone, so the
   registration route ignores the browser's timezone and stores `"UTC"`. Otherwise
   the worker would attempt on days the chain then refuses. The review screen says
   "(UTC)".
2. **"Run now (demo)" is no longer an override.** It submits `execute()` and the
   contract applies the weekday, once-per-day and condition rules. For a demo, make
   the rule for today's UTC weekday. A *refused* fire is not counted as the day's run
   (the contract didn't use the day either); a fire that sends is.
3. **Registration verifies the on-chain weekday, operator and threshold**, not only
   the caps, so the app cannot record a schedule the chain won't honor.
4. `getPermission` stays declared with flat outputs in `abi.ts` (identical encoding
   for an all-static struct, and `chain.ts` reads it positionally). A test now parses
   the Solidity source and fails if the ABI drifts from it.

## Resolved root causes from the old notes

- **Weekday-modulo "mystery" (item 6):** not a contract or Solidity bug. With the
  optimizer on, solc treats `block.timestamp` as constant within a function and reuses
  the pre-warp value after `vm.warp`. Tests now read time via `_now()`
  (`vm.getBlockTimestamp()`). Confirmed by turning the optimizer off (correct values).
- **Failures 1 to 5** were harness bugs, as suspected. The note's suggested fix for #2
  ("reuse the default `id`") would not have worked: its 1-week window resets every
  Friday, so it would stop testing the window cap.

## Window anchor: fixed

The weekly window used to start at the time of day of a send, which could refuse a
legitimate next-week send (weekly cap equal to the amount, 15:00 one Friday then 00:01
the next). It now starts at 00:00 UTC (`_dayStart`), at creation and after every
rollover. The known-issue test was replaced by behavioral tests, and the window logic
was mutation-tested (9 mutants, all caught). The ABI and signatures did not change, so
nothing outside the contract and its tests needed updating. **If you deployed the
previous contract anywhere, redeploy**: windows on existing permissions keep the old
anchoring.

## Found during the first real Sepolia run

- **The web server did not see the root `.env`**, so "savings" fell back to the public demo
  address (`0x90F7...E93b906`) and the balance check said "No server RPC configured". The second
  automation paid that public address instead of the intended wallet (testnet USDC, harmless, but
  it is exactly the failure the product exists to prevent). My earlier end-to-end scripts exported
  the variables, so they never exercised the real startup path. Fixed with
  `frontend/scripts/run-with-env.js`, verified by reproducing it with only a root `.env`.
  The review screen now shows the recipient address and warns on the public default.
- **Worker polled with a 0 ms delay**: a blank `POLL_INTERVAL_MS=` copied from `.env.example`
  became 0. Fixed (`parsePollInterval`, 90 backend tests).
- **Dashboard can disagree with the chain.** Cancel is two steps (on-chain, then a signed record
  in the app). If the second is skipped, the chain says Cancelled while the card says paused, and
  the UI cannot repair it (the contract reverts a second cancel). The app never reads the chain's
  status. Not fixed.

## Contract v2: optional on-chain price condition (built, not deployed)

Done and verified: `createPermissionWithPrice`, the feed checks, the refusals, 31 new contract
tests, 29 mutants, the extended ABI (19-field `getPermission`, the new function and event), and
the registration check that refuses an on-chain price condition the app's record does not
describe. Details are in `contracts/README.md`. The old 9-argument `createPermission` is
unchanged, so the current app keeps working against v2.

**Not done:** the app cannot create or show a price rule yet. Still to build: the intent schema
and parser (an allowlisted asset plus operator and price), the policy engine (feed allowlist from
config, USD-to-feed-units conversion), the worker's off-chain pre-check (so a price refusal does
not make it give up for the day), the review screen and the dashboard.

**Not verified:** no real Chainlink feed has been read. Everything ran against mock feeds. Before
trusting a real feed, check its `description()`, `decimals()` and heartbeat on Arbitrum Sepolia.
Deploying v2 means a new contract address (update both address lines in `.env`); automations
created on the old contract stay on the old contract.

## Frontend redesign: Volo branding and interface

New design system (brand tokens in `tailwind.config.ts`, self-hosted Inter via `@fontsource-variable/inter`,
shared components in `app/components/ui.tsx`), a new **Activity** page, and rebuilt Automate, Review,
Dashboard and Automation pages. All existing flows are preserved: parse, review, approve, register,
pause, resume, cancel, run-now. The logo mark is an SVG recreation of the supplied image (98.8% pixel
overlap) and the original image is the favicon and app icon.

Real data only, and where the old UI could mislead, it now tells the truth:
- **Status is read from the contract** and shown next to the app's record. If they disagree, a banner
  explains it and offers "Update the app's record" (signed, no transaction). This repairs the earlier
  "paused vs cancelled" gap.
- **Execution history is real but only from now on.** `db.ts` keeps each result (newest 50, tested), and
  the record API returns it. Older records show only their latest result.
- **Spending approval is visible and revocable.** The USDC approval equals the weekly cap and is used up
  by each run, so it needs renewing. The detail page shows what remains, warns when it is below one run,
  and can revoke it (that affects all of the wallet's automations, and the dialog says so).
- **The review screen lists what is and is not protected**, and warns when the text was read by the
  offline fallback parser, which cannot tell "above" from "below".
- Wrong network now offers a switch button instead of failing later.

Not changed, on purpose: no ZeroDev integration exists in this code, so the UI never claims one. "Edit"
is not offered, because the contract has no edit; the UI says to cancel and recreate. Internal names
(`PulseAutomation`, env var names, the `pulse.pendingIntent` storage key, package names) still say Pulse.
**One is user-visible:** the text wallets show when asking for a signature starts with "Pulse:" (in
`lib/auth.ts`). Renaming it must change the signer, the verifier, their tests and `local-full.sh`
together, so it is a separate change.

Not tested: no real browser was available, so layout and responsiveness are checked by build, rendered
HTML and class review only, not by eye. Wallet popups, live contract reads and the revoke-approval
transaction have not been exercised against a real wallet or chain from this build.

## Open items (not fixed, decide before deploying)

1. **Still unaudited, and never run against a live chain.** Expect to debug the first
   real Sepolia run. Do `npm run check` before spending gas.
2. The local scripts assume Anvil's clock is the wall clock. Running one within a
   second of UTC midnight can flake.
3. Single-process worker is still the single point of failure (liveness, not safety).

## Environment notes (sandbox)

- Foundry and solc were installed to `/tmp` and are not persisted. Reinstall, then run
  `forge install OpenZeppelin/openzeppelin-contracts@v5.0.2 foundry-rs/forge-std --no-git`
  inside `contracts/` (`contracts/lib/` is not committed).
- `via_ir = true` is required in `foundry.toml` for the contract to compile.
- When testing in a similar sandbox, run servers and the script that curls them in the
  *same* shell invocation; background processes die between calls.
