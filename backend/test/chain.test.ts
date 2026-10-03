import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkPermissionMatches, type ExpectedPermission, type OnChainPermission } from "../src/chain";
import { PULSE_ABI } from "../src/abi";
import { ONCHAIN_OP } from "../src/policyEngine";

const OWNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const TOKEN = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const USDC = 1_000_000n;
const EXPIRES = 1_900_000_000n;

const expected = (over: Partial<ExpectedPermission> = {}): ExpectedPermission => ({
  owner: OWNER, asset: TOKEN, recipient: OTHER,
  maxPerExecution: 10n * USDC, maxPerWindow: 10n * USDC,
  windowSeconds: 604800n, expiresAt: EXPIRES,
  weekday: 5, conditionOp: 0, conditionThreshold: 100n * USDC,
  ...over,
});

/** An on-chain permission that matches expected() exactly; override single fields by index. */
const onchain = (over: Record<number, unknown> = {}): OnChainPermission => {
  const base: unknown[] = [
    OWNER, TOKEN, OTHER, 10n * USDC, 10n * USDC, 604800n, EXPIRES,
    0n, 0n, /*status*/ 0, /*weekday*/ 5, /*op*/ 0, 100n * USDC, /*lastExecutionDay*/ 2n ** 256n - 1n,
  ];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
  return base as unknown as OnChainPermission;
};

test("checkPermissionMatches: an exact match passes", () => {
  assert.deepEqual(checkPermissionMatches(onchain(), expected()), { ok: true });
});

test("checkPermissionMatches: owner/status/asset/recipient/caps/window mismatches are refused (existing checks intact)", () => {
  const cases: [Record<number, unknown>, Partial<ExpectedPermission>, string][] = [
    [{ 0: ZERO }, {}, "No such permission on-chain."],
    [{ 0: OTHER }, {}, "That permission belongs to a different wallet."],
    [{ 9: 2 }, {}, "That permission is not active on-chain."],
    [{ 9: 1 }, {}, "That permission is not active on-chain."],
    [{ 1: OTHER }, {}, "On-chain token does not match."],
    [{ 2: OWNER }, {}, "On-chain recipient does not match."],
    [{ 3: 9n * USDC }, {}, "On-chain caps do not match."],
    [{ 4: 11n * USDC }, {}, "On-chain caps do not match."],
    [{ 5: 86400n }, {}, "On-chain window or expiry does not match."],
    [{ 6: EXPIRES + 1n }, {}, "On-chain window or expiry does not match."],
  ];
  for (const [chain, exp, reason] of cases) {
    assert.deepEqual(checkPermissionMatches(onchain(chain), expected(exp)), { ok: false, reason });
  }
});

test("checkPermissionMatches: a different on-chain weekday is refused", () => {
  for (const day of [0, 1, 2, 3, 4, 6]) {
    assert.deepEqual(
      checkPermissionMatches(onchain({ 10: day }), expected({ weekday: 5 })),
      { ok: false, reason: "On-chain weekday does not match." }
    );
  }
});

test("checkPermissionMatches: a different on-chain operator or threshold is refused", () => {
  for (const op of [1, 2, 3, 4]) {
    assert.deepEqual(
      checkPermissionMatches(onchain({ 11: op }), expected({ conditionOp: 0 })),
      { ok: false, reason: "On-chain balance condition does not match." }
    );
  }
  assert.deepEqual(
    checkPermissionMatches(onchain({ 12: 1n }), expected()),
    { ok: false, reason: "On-chain balance condition does not match." }
  );
  // off-by-one-base-unit is still a mismatch, never "close enough"
  assert.deepEqual(
    checkPermissionMatches(onchain({ 12: 100n * USDC + 1n }), expected()),
    { ok: false, reason: "On-chain balance condition does not match." }
  );
});

test("checkPermissionMatches: earlier checks still win over schedule checks (stable reasons)", () => {
  // caps wrong AND weekday wrong -> the caps reason is reported, as before this feature
  assert.deepEqual(
    checkPermissionMatches(onchain({ 3: 9n * USDC, 10: 2 }), expected()),
    { ok: false, reason: "On-chain caps do not match." }
  );
});

// ------------------------------------------------------------------ drift guards
// The ABI string is hand-written TypeScript; the contract is the source of truth. These read
// the Solidity source (when present) so a signature change can never go unnoticed again.
const SOL = path.resolve(__dirname, "../../contracts/src/PulseAutomation.sol");
const haveSol = fs.existsSync(SOL);
const sol = haveSol ? fs.readFileSync(SOL, "utf8") : "";

test("abi: createPermission inputs match the Solidity function, in order", { skip: !haveSol }, () => {
  const m = sol.match(/function createPermission\(([\s\S]*?)\)\s*external/);
  assert.ok(m, "createPermission not found in the contract");
  const solParams = m[1].split(",").map((p) => p.trim().split(/\s+/));
  const item = PULSE_ABI.find((x) => x.type === "function" && x.name === "createPermission") as any;
  assert.deepEqual(item.inputs.map((i: any) => i.name), solParams.map((p) => p[p.length - 1]));
  // Enum params are uint8 on the wire.
  assert.deepEqual(
    item.inputs.map((i: any) => i.type),
    solParams.map((p) => (p[0] === "Op" ? "uint8" : p[0]))
  );
});

test("abi: getPermission outputs match the Permission struct field order", { skip: !haveSol }, () => {
  const m = sol.match(/struct Permission \{([\s\S]*?)\}/);
  assert.ok(m, "Permission struct not found");
  const fields = [...m[1].matchAll(/^\s*(\w+)\s+(\w+);/gm)].map((x) => ({ type: x[1], name: x[2] }));
  const item = PULSE_ABI.find((x) => x.type === "function" && x.name === "getPermission") as any;
  assert.deepEqual(item.outputs.map((o: any) => o.name), fields.map((f) => f.name));
  assert.deepEqual(
    item.outputs.map((o: any) => o.type),
    fields.map((f) => (f.type === "Status" || f.type === "Op" ? "uint8" : f.type))
  );
});

test("abi: PermissionCreated event args match the Solidity event", { skip: !haveSol }, () => {
  const m = sol.match(/event PermissionCreated\(([\s\S]*?)\);/);
  assert.ok(m, "PermissionCreated event not found");
  const solParams = m[1].split(",").map((p) => p.trim().split(/\s+/));
  const item = PULSE_ABI.find((x) => x.type === "event" && x.name === "PermissionCreated") as any;
  assert.deepEqual(item.inputs.map((i: any) => i.name), solParams.map((p) => p[p.length - 1]));
});

test("ONCHAIN_OP indexes match the Solidity Op enum declaration order", { skip: !haveSol }, () => {
  const m = sol.match(/enum Op \{([^}]*)\}/);
  assert.ok(m, "Op enum not found");
  const solOps = m[1].split(",").map((s) => s.trim());
  const bySymbol: Record<string, string> = { GT: ">", GTE: ">=", LT: "<", LTE: "<=", EQ: "==" };
  solOps.forEach((name, index) => {
    assert.equal(ONCHAIN_OP[bySymbol[name] as keyof typeof ONCHAIN_OP], index, `Op.${name}`);
  });
  assert.equal(solOps.length, Object.keys(ONCHAIN_OP).length);
});
