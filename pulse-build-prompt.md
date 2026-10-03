# Pulse — Build Prompt

Use this as the working spec/prompt for building the Pulse hackathon MVP. Paste it into a coding agent (Claude Code or similar) as the project brief, or use it as your own reference while building.

---

## What you're building

**Pulse** is an intent layer for onchain automation on Arbitrum. A user describes what they want in natural language ("Every Friday, if my USDC balance is above $100, send $10 to my savings wallet"). Pulse converts that into a structured, constrained, auditable rule; shows the user exactly what it understood; and — once approved — executes it automatically through smart-account infrastructure, enforced by onchain permissions rather than by trusting the AI or the backend.

**One-liner:** Tell Pulse what you want. It handles the rest, within the limits you define.

**Technical thesis:** AI interprets intent. A policy engine defines authority. A smart account enforces permissions. Arbitrum executes. Ethereum settles.

This is explicitly **not** "an AI wallet" and not another smart-wallet product. The differentiation is the translation layer between ambiguous human language and a safe, human-legible, portable policy — not the execution infrastructure itself, which should be composed from an existing smart-account/account-abstraction provider.

---

## Non-negotiable design principle

The AI never has direct spending authority. Its only job is: natural language → structured rule, within a fixed schema. It cannot construct arbitrary calldata, expand its own allowlist, or bypass the policy engine. If the AI's output doesn't validate against the schema, it is rejected outright — never "best-effort" filled in or auto-corrected into something plausible.

```
AI            → understands
Policy Engine → restricts
Smart Account → enforces
Arbitrum      → executes
Ethereum      → settles
```

---

## MVP scope (hackathon — deliberately narrow)

Build **one** end-to-end loop, polished, not a general protocol:

- **One chain:** Arbitrum Sepolia for dev, Arbitrum One for demo if time allows.
- **One asset:** USDC.
- **One action type:** conditional recurring transfer (skip approved-contract-call variant for MVP).
- **One interface:** natural-language text input.
- **One permission model:** capped amount + expiration, nothing more configurable.
- **Smart-account provider:** pick one now (e.g. ZeroDev or Safe modules) and hardcode against it. Do **not** build the multi-provider execution router for the MVP — that's legitimate v2 architecture, but building it now is scope creep wearing a v1 costume.
- **Trigger:** for the demo, allow the condition to be fired manually/on a button rather than a real cron watching real time — the point is proving the loop, not proving uptime.
- **Controls:** Pause and Cancel only. Skip Edit — an edit is just cancel + recreate for MVP purposes.

The full loop to demonstrate:

```
Intent → Rule → Safety → Preview → Approval → Automation → Execution → Revocation
```

---

## Screens

1. **Home** — single text input ("What do you want to automate?") + list of active automations.
2. **Rule review** — shows the parsed trigger / condition / action / recipient / cap / expiration, in plain language, with explicit checkmarks: "Spending limit enforced," "Recipient restricted," "No unrestricted wallet access."
3. **Check rule** (see naming note below) — validates the policy is well-formed and would currently succeed; not a prediction of future state.
4. **Approve** — user signs once to grant the constrained permission, not per-transaction.
5. **Dashboard** — active automations, next execution, pause/manage per card.
6. **Automation detail** — full permission summary, execution history, pause/cancel.
7. **Execution result** — success or rejection (e.g. "Amount exceeds weekly spending limit"), with tx hash on success.

---

## Fixes to build in from the start (not deferred)

### 1. "Simulate" is two different claims — don't conflate them

Do not present a single "Simulate" step that implies you've modeled the future outcome. Split it:

- **Rule check** (at approval time): confirms the policy is well-formed and would succeed *given current state* — valid recipient, valid contract, current balance meets the condition. Button label: "Check rule," not "Simulate."
- **Execution preview** (shown in history, after the fact): the actual outcome once the condition fires, since balance/state at execution time is unknown in advance.

### 2. Prompt-injection resistance is part of the security model, not a research item

The intent parser outputs only into a fixed schema (trigger / condition / action / amount / recipient), validated against an allowlist of action types and pre-approved contracts. Free text — from the user, or from any external content the AI might read — can influence interpretation but can never directly produce callable calldata, expand the action allowlist, or override the recipient/spending caps the policy engine sets. Any parser output that doesn't fit the schema is rejected, not coerced into something valid.

```json
{
  "trigger": { "type": "schedule", "frequency": "weekly", "day": "friday" },
  "condition": { "asset": "USDC", "operator": ">", "balance": "100" },
  "action": { "type": "transfer", "asset": "USDC", "amount": "10" },
  "recipient": "approved_savings_wallet",
  "max_per_execution": "10",
  "max_per_week": "10",
  "expiration": "2027-09-27"
}
```

Reject anything that doesn't parse cleanly into this shape. No partial trust.

### 3. The trigger-watcher is a placeholder, say so explicitly

The MVP's backend worker that polls for trigger conditions is a demo convenience and a known single point of failure — if it's down, "every Friday" silently doesn't happen and the user has no idea. State this directly in the pitch: the production path replaces it with a decentralized keeper network (Chainlink Automation or Gelato Web3 Functions) so trigger-watching isn't dependent on one process. Explicitly out of scope for the hackathon build itself.

### 4. Have the differentiation answer ready

Smart-account providers (ZeroDev, others) are themselves moving toward intent-based authorization and agentic session-key workflows in 2026 — that trend validates the thesis rather than undermining it. The answer when asked "why won't they just build this": shipping a session-key primitive is different from owning the translation from ambiguous human language into a safe, auditable, portable policy. Pulse can also swap which provider enforces the policy without changing the user's experience — a single provider's own intent layer can't offer that by definition, the same way Stripe sits on rails that could theoretically build their own billing UX but don't, because it's a different job.

---

## Tech stack

- **Frontend:** Next.js, TypeScript, Tailwind CSS.
- **Smart contracts:** Solidity, OpenZeppelin, on Arbitrum Sepolia → Arbitrum One.
- **Account infrastructure:** one established smart-account/account-abstraction provider (decide before coding starts).
- **AI:** LLM used strictly for intent parsing into the fixed schema above, plus generating the plain-language explanation shown on the review screen. No other authority.
- **Backend:** Node.js/TypeScript — trigger polling (MVP placeholder per fix #3), condition checking, execution submission, rule storage, execution history.
- **Database:** automation definitions, execution history, status, metadata. Never store private keys.

---

## Acceptance criteria for the demo

- User types a natural-language rule and sees it parsed correctly into the schema.
- Review screen shows trigger/condition/action/cap/expiration with the three security checkmarks.
- "Check rule" validates against current state (not a future prediction) and is labeled accurately.
- Approval creates a real, capped, expiring onchain permission via the chosen smart-account provider — not just a database row.
- Manually firing the condition triggers real execution on Arbitrum Sepolia, visible on a block explorer.
- An out-of-policy execution attempt (e.g. amount over the cap) is rejected on-chain, and the rejection reason is surfaced in the UI.
- Cancel revokes the actual onchain permission, not just a UI/database flag — verify the underlying authorization no longer exists.
