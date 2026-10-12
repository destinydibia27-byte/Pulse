# PulseAutomation contract

Minimal, **unaudited** MVP contract. One asset per permission, one action type
(transfer), a per-execution cap, a fixed-window cap, an expiration, a single
locked recipient, a weekday, and a balance condition. Every check runs on-chain
inside `execute()`.

## What the chain enforces (and what it does not)

Enforced on-chain, regardless of who calls or what the backend believes:
- funds only ever go to the recipient fixed at creation
- per-execution cap and per-window cap
- expiration, pause, and permanent cancel (owner only)
- **the weekday** ("every Friday"), **once per UTC day**, and **the balance
  condition** ("if balance > 100"), all checked inside `execute()`
- only the configured `executor` may call `execute()`

`execute()` checks, in order: status, weekday, once-per-day, balance condition,
then the amount against both caps. A rejected or reverted attempt never uses up
the day: `lastExecutionDay` is recorded only after a successful send.

**The schedule is in UTC, not the user's local time.** The chain has no reliable
source of a timezone, so "Friday" means Friday 00:00-23:59 UTC. For someone in
Lagos (UTC+1) that is a one-hour shift at the edge of the day; for someone in
California it is most of a different local evening. The app says "(UTC)" on the
review screen and stores every schedule as UTC so the worker and the contract
always agree.

**What a compromised executor can still do:** nothing outside the rules above
(`test_trustBoundary_executorCannotControlTimingOrCondition`). It can no longer
send on the wrong day, twice in a day, or when the balance condition is unmet.
What it can still do is *fail to act*: it decides whether to call `execute()` at
all (`test_trustBoundary_executorCanStillChooseNotToAct`). That is a liveness
problem, not a safety one, and is why the production path replaces the single
worker with a keeper network.

**The window is fixed, not sliding.** The counter resets on the first
`execute()` after `windowSeconds` elapses, so up to 2x the cap can leave within
moments of a boundary (`test_execute_fixedWindowBoundaryAllowsDoubleSpendKnownBehavior`).
Don't describe the cap to users as "per any 7 days".

**Windows start at 00:00 UTC, not at the moment of a send.** An earlier version
anchored the window to the time of day of the send that started it, which wrongly
refused a legitimate weekly send: with `maxPerWindow` equal to the amount, a send at
15:00 one Friday followed by a 00:01 attempt the next Friday still fell inside the old
window and was rejected as "Amount exceeds weekly spending limit" (a skipped week).
The window now starts at the beginning of the UTC day, both at creation and after
each rollover (`_dayStart`), so a weekday schedule is never penalized for sending
earlier in the day than last time. Covered by
`test_window_weeklySendsSucceedRegardlessOfTimeOfDay` and four more `test_window_*`
tests. A side effect: the first window can be up to 24 hours shorter than
`windowSeconds`, which is within the already-documented fixed-window behavior above.

**Rejections don't revert.** `execute()` emits `ExecutionRejected(id, reason)` and
returns, so a rejected call is still a mined, successful transaction. Callers must
read the events (see `readOutcome` in `chain.ts`). Only true failures (e.g. the
user's allowance or balance is too low) revert.

## Optional price condition (Chainlink-style feed)

`createPermissionWithPrice(...)` is `createPermission(...)` plus a market condition, e.g.
"only while ETH < $2,500". The plain `createPermission` is unchanged and creates a permission
with no price condition.

- **Enforced on-chain.** `execute()` reads the feed's `latestRoundData()` itself, so a
  compromised worker cannot send when the condition is false. Check order: status, weekday,
  once-per-day, balance condition, **price**, then amount and caps.
- **Three refusals, all without using up the day** (so the same permission can send later if
  the price crosses): `Price condition not met`, `Price feed stale` (answer older than the
  permission's `maxAge`; exactly `maxAge` old is still fresh), and `Price feed unavailable`
  (the feed reverts, has no code, reports a non-positive answer, or has no update time).
  A refusal is an event, not a revert.
- **Creation refuses anything that is not a working feed:** zero address, no code, a feed whose
  `decimals()` fails or exceeds 18, one that cannot return a positive answer right now, a zero
  threshold, and a `maxAge` of 0 or above 7 days. Freshness is deliberately *not* required at
  creation, so a quiet testnet feed does not stop you creating a rule.
- **Units.** The threshold is in the feed's own decimals (8 for the common USD feeds); the
  contract records the feed's `decimals()` so the app can check the scale it sent.
- **The feed is fixed at creation.** There is no setter. Anyone can create a permission against
  any feed, but the only person at risk is the creator (their own funds, their own recipient and
  caps), which `test_trustBoundary_attackerFeedIsOnlyTheCreatorsOwnRisk` documents. The *app*
  allowlists feeds off-chain, so the AI can never choose one.
- **Known limits.** No sequencer-uptime check (after an L2 sequencer outage a feed can briefly
  look fresh while lagging), no TWAP or multi-feed median, and one feed per permission. Feed
  addresses are **not** hardcoded: take them from Chainlink's own documentation and verify
  `description()` and `decimals()` on-chain before use. A feed returning *malformed* data can
  still revert the whole call (a decode failure cannot be caught); no funds move and the worker
  retries.
- `permissions` is a private mapping now; `getPermission(id)` is the one accessor (the extra
  public getter returned 19 values and broke the optimizer-off build).

## Setup (Foundry)

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.0.2 foundry-rs/forge-std --no-git
```

`foundry.toml` already has the remappings. The contract targets OpenZeppelin **v5**
(`Ownable(msg.sender)`, `utils/ReentrancyGuard.sol`).

## Test

```bash
forge test -vv
```

91 tests (60 in `PulseAutomation.t.sol`, 31 in `PulsePrice.t.sol`): creation validation, every rejection path, weekday enforcement (all
seven days, day boundaries, fuzzed), once-per-day, all five condition operators
(checked against the off-chain implementation), window reset, UTC-day anchoring and
boundary behavior, pause/resume/cancel and access control, executor rotation, plus fuzz
tests asserting the caps can never be exceeded and non-executors can never move
funds. The 31 price tests cover feed validation, all five operators at their boundaries,
staleness at exactly `maxAge`, every unavailable-feed case (including a feed whose code vanishes
via `vm.etch`), check ordering, caps, and a fuzz comparison against the off-chain operator
semantics. The suite also builds and passes with the optimizer off.

**Writing tests that warp time: never read `block.timestamp` after `vm.warp`.**
With the optimizer on, solc treats `block.timestamp` as constant within a function
and can reuse the pre-warp value, so arithmetic derived from it silently uses the
wrong time. The test file reads time through `_now()` (`vm.getBlockTimestamp()`)
everywhere. This is a test-harness hazard only: on-chain a transaction has exactly
one timestamp.

## Local end-to-end (real backend code vs a real contract)

```bash
bash script/local-e2e.sh
```

Starts Anvil on chain id 421614, deploys the contract and a mock USDC, creates a
permissions as a user, then runs `backend/src/chain.ts` as the executor and asserts
on decoded on-chain outcomes: a send on the right day, and the contract's refusals
for a second send the same day, an unmet balance condition, the wrong weekday,
an over-cap amount, and a cancelled permission. It also checks that no rejection
uses up the day. Requires `npm install` in `../backend`. Uses Anvil's public dev
keys only.

## Deploy to Arbitrum Sepolia

```bash
export EXECUTOR_ADDRESS=0x...        # address of the wallet whose key you'll use as EXECUTOR_PRIVATE_KEY
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $ARBITRUM_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast
```

The deployer becomes the contract `owner` (can rotate the executor). The
executor wallet needs a little Sepolia ETH for gas. Put the printed address in
`.env` as both `PULSE_CONTRACT_ADDRESS` and `NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS`.

Use a throwaway deployer key for testnet. Never reuse a key that holds real funds.

## USDC address

`frontend/lib/constants.ts` holds Circle's documented Arbitrum Sepolia USDC
(`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`) with its source. Confirm it on your
RPC with `backend/scripts/verify-usdc.ts`. Do not use Arbitrum One's USDC
(`0xaf88...5831`) on testnet, and don't trust addresses from unofficial pages:
several third-party sites list different, wrong values.
