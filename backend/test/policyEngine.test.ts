import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ONCHAIN_OP,
  ONCHAIN_WEEKDAY,
  toBaseUnits,
  formatUsdc,
  checkRule,
  resolvePolicy,
  PolicyRejection,
  type ResolvedPolicy,
} from "../src/policyEngine";
import { IntentSchema, parseIntentStrict, IntentValidationError, type Intent } from "../src/schema";

const USDC = 1_000_000n;
const ADDR = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const TOKEN = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;

const policy = (over: Partial<ResolvedPolicy> = {}): ResolvedPolicy => ({
  asset: TOKEN,
  recipient: ADDR,
  maxPerExecution: 10n * USDC,
  maxPerWindow: 10n * USDC,
  windowSeconds: 604800,
  expiresAt: Math.floor(Date.now() / 1000) + 86400,
  weekday: 5,
  conditionOp: 0,
  conditionThreshold: 100n * USDC,
  ...over,
});

const intent = (over: Record<string, unknown> = {}): Intent =>
  parseIntentStrict({
    trigger: { type: "schedule", frequency: "weekly", day: "friday" },
    condition: { asset: "USDC", operator: ">", balance: "100" },
    action: { type: "transfer", asset: "USDC", amount: "10" },
    recipientId: "savings",
    maxPerExecution: "10",
    maxPerWindow: "10",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  });

// ---------------------------------------------------------------- toBaseUnits
test("toBaseUnits: whole, fractional, and zero", () => {
  assert.equal(toBaseUnits("10"), 10n * USDC);
  assert.equal(toBaseUnits("0.5"), 500_000n);
  assert.equal(toBaseUnits("100.25"), 100_250_000n);
  assert.equal(toBaseUnits("0"), 0n);
  assert.equal(toBaseUnits("0.000001"), 1n);
});

test("toBaseUnits: exactly 6 decimals is fine, 7 is rejected (never silently truncated)", () => {
  assert.equal(toBaseUnits("1.234567"), 1_234_567n);
  assert.throws(() => toBaseUnits("1.2345678"), PolicyRejection);
});

test("toBaseUnits: very large values stay exact (no float precision loss)", () => {
  assert.equal(toBaseUnits("9007199254740993"), 9007199254740993n * USDC);
});

// ----------------------------------------------------------------- formatUsdc
test("formatUsdc: readable output", () => {
  assert.equal(formatUsdc(10n * USDC), "10.00");
  assert.equal(formatUsdc(500_000n), "0.50");
  assert.equal(formatUsdc(1_234_567n), "1.234567");
  assert.equal(formatUsdc(0n), "0.00");
});

// ------------------------------------------------------------------- checkRule
test("checkRule: balance not read -> nulls, still well-formed, no warnings", () => {
  const r = checkRule(policy(), null, ">", 100n * USDC);
  assert.equal(r.wellFormed, true);
  assert.equal(r.currentConditionWouldPass, null);
  assert.equal(r.balanceCoversExecution, null);
  assert.deepEqual(r.warnings, []);
});

test("checkRule: every operator, on both sides of the boundary", () => {
  const t = 100n * USDC;
  const run = (op: any, bal: bigint) => checkRule(policy(), bal, op, t).currentConditionWouldPass;
  assert.equal(run(">", t + 1n), true);
  assert.equal(run(">", t), false); // strict
  assert.equal(run(">=", t), true);
  assert.equal(run(">=", t - 1n), false);
  assert.equal(run("<", t - 1n), true);
  assert.equal(run("<", t), false);
  assert.equal(run("<=", t), true);
  assert.equal(run("<=", t + 1n), false);
  assert.equal(run("==", t), true);
  assert.equal(run("==", t + 1n), false);
});

test("checkRule: balance below the send amount warns but does NOT block approval", () => {
  const r = checkRule(policy(), 5n * USDC, ">", 100n * USDC);
  assert.equal(r.balanceCoversExecution, false);
  assert.equal(r.wellFormed, true); // must stay approvable: user may fund later
  assert.equal(r.issues.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /5\.00 USDC/);
  assert.match(r.warnings[0], /10\.00 USDC/);
});

test("checkRule: balance exactly equal to the send amount covers it", () => {
  const r = checkRule(policy(), 10n * USDC, ">", 100n * USDC);
  assert.equal(r.balanceCoversExecution, true);
  assert.deepEqual(r.warnings, []);
});

test("checkRule: expired policy and zero cap are hard issues", () => {
  const expired = checkRule(policy({ expiresAt: 1 }), null, ">", 0n);
  assert.equal(expired.wellFormed, false);
  assert.match(expired.issues.join(" "), /expired/i);

  const zero = checkRule(policy({ maxPerExecution: 0n }), null, ">", 0n);
  assert.equal(zero.wellFormed, false);
});

test("checkRule: condition failing right now is NOT an issue or warning", () => {
  const r = checkRule(policy(), 50n * USDC, ">", 100n * USDC);
  assert.equal(r.currentConditionWouldPass, false);
  assert.equal(r.wellFormed, true);
  assert.deepEqual(r.warnings, []); // 50 >= 10 send amount, so nothing to warn about
});

// --------------------------------------------------------------- resolvePolicy
const approved = { demo: { savings: ADDR } };

test("resolvePolicy: maps label to approved address and converts caps", () => {
  const p = resolvePolicy("demo", intent(), TOKEN, approved);
  assert.equal(p.recipient, ADDR);
  assert.equal(p.maxPerExecution, 10n * USDC);
  assert.equal(p.windowSeconds, 604800);
});

test("resolvePolicy: unapproved recipient label is rejected", () => {
  assert.throws(
    () => resolvePolicy("demo", intent({ recipientId: "attacker" }), TOKEN, approved),
    PolicyRejection
  );
});

test("resolvePolicy: unknown user is rejected", () => {
  assert.throws(() => resolvePolicy("nobody", intent(), TOKEN, approved), PolicyRejection);
});

test("resolvePolicy: per-execution cap above window cap is rejected", () => {
  assert.throws(
    () => resolvePolicy("demo", intent({ maxPerExecution: "20", maxPerWindow: "10" }), TOKEN, approved),
    PolicyRejection
  );
});

test("resolvePolicy: past expiry is rejected", () => {
  assert.throws(
    () =>
      resolvePolicy("demo", intent({ expiresAt: new Date(Date.now() - 1000).toISOString() }), TOKEN, approved),
    PolicyRejection
  );
});

test("resolvePolicy: >6 decimal cap is rejected, not truncated", () => {
  assert.throws(
    () => resolvePolicy("demo", intent({ maxPerExecution: "1.1234567", maxPerWindow: "5" }), TOKEN, approved),
    PolicyRejection
  );
});

// ---------------------------------------------- schema: the injection boundary
test("schema: rejects an extra/unknown action type (allowlist holds)", () => {
  assert.throws(
    () => parseIntentStrict({ ...intent(), action: { type: "approve", asset: "USDC", amount: "10" } }),
    IntentValidationError
  );
});

test("schema: rejects a raw address smuggled in as the recipient shape? (label only)", () => {
  // A raw 0x address is accepted by the schema as an opaque label string, but it can
  // never resolve: policyEngine only maps labels the user pre-approved.
  const smuggled = intent({ recipientId: "0x000000000000000000000000000000000000dEaD" });
  assert.throws(() => resolvePolicy("demo", smuggled, TOKEN, approved), PolicyRejection);
});

test("schema: rejects non-numeric / negative / scientific-notation amounts", () => {
  for (const bad of ["-5", "1e6", "ten", "", "1,000", " 5", "0x10"]) {
    assert.equal(
      IntentSchema.safeParse({ ...intent(), action: { type: "transfer", asset: "USDC", amount: bad } }).success,
      false,
      `should reject amount ${JSON.stringify(bad)}`
    );
  }
});

test("schema: rejects other assets and non-weekly schedules (MVP scope)", () => {
  assert.throws(() => parseIntentStrict({ ...intent(), condition: { asset: "ETH", operator: ">", balance: "1" } }));
  assert.throws(() =>
    parseIntentStrict({ ...intent(), trigger: { type: "schedule", frequency: "daily", day: "friday" } })
  );
});

test("schema: unknown extra top-level fields are stripped, not trusted", () => {
  const parsed = parseIntentStrict({ ...intent(), sendTo: "0xdeadbeef", spendLimit: "999999" }) as any;
  assert.equal(parsed.sendTo, undefined);
  assert.equal(parsed.spendLimit, undefined);
});

// ------------------------------------------- on-chain schedule/condition fields
test("resolvePolicy: exposes the on-chain weekday, operator and threshold", () => {
  const p = resolvePolicy(
    "demo",
    intent({
      trigger: { type: "schedule", frequency: "weekly", day: "sunday" },
      condition: { asset: "USDC", operator: "<=", balance: "12.5" },
    }),
    TOKEN,
    approved
  );
  assert.equal(p.weekday, 0, "Sunday is 0 on-chain");
  assert.equal(p.conditionOp, 3, "<= is LTE (index 3) on-chain");
  assert.equal(p.conditionThreshold, 12_500_000n, "threshold is in USDC base units");
});

test("ONCHAIN_WEEKDAY agrees with the real UTC calendar for all seven days", () => {
  // 2027-01-17 is a Sunday (UTC). Independent of the table under test: JS getUTCDay().
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(2027, 0, 17 + i));
    assert.equal(ONCHAIN_WEEKDAY[names[d.getUTCDay()]], d.getUTCDay());
  }
  assert.equal(new Set(Object.values(ONCHAIN_WEEKDAY)).size, 7, "no two days share a number");
});

test("ONCHAIN_OP covers every schema operator exactly once", () => {
  const ops = IntentSchema.shape.condition.shape.operator.options;
  assert.deepEqual([...ops].sort(), Object.keys(ONCHAIN_OP).sort());
  assert.equal(new Set(Object.values(ONCHAIN_OP)).size, ops.length);
});
