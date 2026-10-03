import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildRegisterMessage,
  buildActionMessage,
  verifyAuth,
  AUTH_WINDOW_MS,
} from "../src/auth";
import { consumeOnce, sweepExpired, _resetForTests } from "../src/nonceGuard";

// Well-known Anvil dev keys. Public, never used for real funds.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ATTACKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const owner = privateKeyToAccount(OWNER_KEY);
const attacker = privateKeyToAccount(ATTACKER_KEY);

const NOW = 1_800_000_000_000;

test("valid signature, fresh timestamp: accepted, signer recovered correctly", async () => {
  const msg = buildRegisterMessage("0", owner.address, NOW);
  const sig = await owner.signMessage({ message: msg });
  const r = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW);
  assert.deepEqual(r, { ok: true, signer: owner.address });
});

test("signature from a different wallet than the claimed owner is rejected", async () => {
  const msg = buildRegisterMessage("0", owner.address, NOW); // claims to be `owner`...
  const sig = await attacker.signMessage({ message: msg }); // ...but attacker actually signed it
  const r = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /not made by the expected wallet/);
});

test("signature for one action does not verify for a different action (message binding)", async () => {
  const sig = await owner.signMessage({ message: buildActionMessage("demo-0", "cancel", NOW) });
  const differentAction = buildActionMessage("demo-0", "fire", NOW); // same id, different verb
  const r = await verifyAuth({ message: differentAction, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW);
  assert.equal(r.ok, false);
});

test("signature for one automation id does not verify for a different id", async () => {
  const sig = await owner.signMessage({ message: buildActionMessage("demo-0", "cancel", NOW) });
  const differentId = buildActionMessage("demo-1", "cancel", NOW);
  const r = await verifyAuth({ message: differentId, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW);
  assert.equal(r.ok, false);
});

test("timestamp inside the window is accepted at both edges", async () => {
  const msg = buildActionMessage("demo-0", "pause", NOW);
  const sig = await owner.signMessage({ message: msg });
  const okLate = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW + AUTH_WINDOW_MS);
  const okEarly = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW - AUTH_WINDOW_MS);
  assert.equal(okLate.ok, true);
  assert.equal(okEarly.ok, true);
});

test("timestamp just outside the window is rejected (both directions)", async () => {
  const msg = buildActionMessage("demo-0", "pause", NOW);
  const sig = await owner.signMessage({ message: msg });
  const tooLate = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW + AUTH_WINDOW_MS + 1);
  const tooEarly = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, NOW - AUTH_WINDOW_MS - 1);
  assert.equal(tooLate.ok, false);
  assert.match((tooLate as any).reason, /expired/);
  assert.equal(tooEarly.ok, false);
});

test("a stale signature replayed long after (captured request) is rejected", async () => {
  const msg = buildActionMessage("demo-0", "fire", NOW);
  const sig = await owner.signMessage({ message: msg });
  const muchLater = NOW + 24 * 3600_000; // a day later
  const r = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NOW }, muchLater);
  assert.equal(r.ok, false);
});

test("malformed signature is rejected without throwing", async () => {
  const msg = buildActionMessage("demo-0", "pause", NOW);
  for (const bad of ["0xnotasignature", "", "0x1234", "not-hex-at-all"]) {
    const r = await verifyAuth({ message: msg, signature: bad as any, expectedSigner: owner.address, timestamp: NOW }, NOW);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("missing/NaN timestamp is rejected", async () => {
  const msg = buildActionMessage("demo-0", "pause", NOW);
  const sig = await owner.signMessage({ message: msg });
  const r = await verifyAuth({ message: msg, signature: sig, expectedSigner: owner.address, timestamp: NaN as any }, NOW);
  assert.equal(r.ok, false);
});

test("tampering with any byte of the signature is rejected, not silently accepted", async () => {
  const msg = buildActionMessage("demo-0", "cancel", NOW);
  const sig = await owner.signMessage({ message: msg });
  const tampered = ("0x" + "f" + sig.slice(3)) as `0x${string}`; // flip one nibble
  const r = await verifyAuth({ message: msg, signature: tampered, expectedSigner: owner.address, timestamp: NOW }, NOW);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- nonceGuard
test("nonceGuard: first use succeeds, replay is rejected", () => {
  _resetForTests();
  const sig = "0xabc123";
  assert.equal(consumeOnce(sig, Date.now() + 1000), true);
  assert.equal(consumeOnce(sig, Date.now() + 1000), false);
});

test("nonceGuard: case-insensitive (signatures are hex, case shouldn't matter)", () => {
  _resetForTests();
  assert.equal(consumeOnce("0xABC123", Date.now() + 1000), true);
  assert.equal(consumeOnce("0xabc123", Date.now() + 1000), false);
});

test("nonceGuard: different signatures are independent", () => {
  _resetForTests();
  assert.equal(consumeOnce("0x111", Date.now() + 1000), true);
  assert.equal(consumeOnce("0x222", Date.now() + 1000), true);
});

test("nonceGuard: sweepExpired removes only expired entries", () => {
  _resetForTests();
  const now = Date.now();
  consumeOnce("0xold", now - 1000); // already expired
  consumeOnce("0xnew", now + 100_000); // not expired
  sweepExpired(now);
  assert.equal(consumeOnce("0xold", now + 1000), true, "expired entry should have been swept, freeing it up");
  assert.equal(consumeOnce("0xnew", now + 1000), false, "unexpired entry should NOT be swept");
});
