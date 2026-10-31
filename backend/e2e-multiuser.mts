/**
 * End-to-end check of the multi-user behaviour against a RUNNING server (two wallets, attacks, caps).
 * Start the app first, with these settings so the checks are deterministic and nothing real is touched:
 *   cd frontend && PULSE_DB_PATH=/tmp/volo-e2e/automations.json MAX_AUTOMATIONS_PER_OWNER=1 \
 *     RATE_LIMIT_SCALE=100 ENABLE_DEMO_FIRE=false npm run start -- -p 4010
 * (no SUPABASE_*, no RPC or contract settings: it runs in offline mode, so no chain is needed)
 * Then, from backend/:
 *   BASE=http://127.0.0.1:4010 npx tsx e2e-multiuser.mts
 * The rate-limit check needs default limits: restart the server WITHOUT RATE_LIMIT_SCALE and run:
 *   MODE=ratelimit BASE=http://127.0.0.1:4010 npx tsx e2e-multiuser.mts
 * The keys below are well-known public test keys, not secrets.
 */
import { privateKeyToAccount } from "viem/accounts";
import { buildRecipientSetMessage, buildRecipientRemoveMessage, buildRegisterMessage, buildActionMessage } from "../frontend/lib/auth";

const BASE = process.env.BASE!;
const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const ALICE_SAVE = "0x01aD5f069a436f67fDCED12babE12CD9e2C19BB1";
const BOB_SAVE = "0x048d453f8fA81ef9CE18f66Dd88ACEC202796a81";
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + extra}`); };
const j = async (path: string, init?: RequestInit) => { const r = await fetch(BASE + path, init); let b: any = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
const post = (path: string, body: unknown) => j(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function setRecipient(acct: typeof alice, label: string, address: string, ts = Date.now()) {
  const signature = await acct.signMessage({ message: buildRecipientSetMessage(acct.address, label, address, ts) });
  return { signature, ts, res: await post("/api/recipients", { op: "set", owner: acct.address, label, address, signature, timestamp: ts }) };
}

if (process.env.MODE === "ratelimit") {
// ---- 8. rate limit on signed writes (limit 10/min per caller)
let limited = 0;
for (let i = 0; i < 14; i++) {
  const t = Date.now() + 100 + i;
  const s = await alice.signMessage({ message: buildRecipientRemoveMessage(alice.address, `x${i}`, t) });
  const x = await post("/api/recipients", { op: "remove", owner: alice.address, label: `x${i}`, signature: s, timestamp: t });
  if (x.status === 429) limited++;
}
check("rapid writes are rate limited (429)", limited > 0, `limited=${limited}`);


  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const text = "Every Friday, send $10 to my savings wallet when my balance is above $100.";
const parsed = await post("/api/parse", { text });
check("parse returns an intent", parsed.body?.ok === true, JSON.stringify(parsed.body));
const intent = parsed.body.intent;

// ---- 1. nothing saved yet: a rule naming "savings" is refused for everyone
let r = await post("/api/policy-check", { intent, owner: alice.address });
check("no recipient saved -> rule refused", r.status === 422 && /pre-approved recipient/.test(r.body.reason), JSON.stringify(r));
r = await post("/api/policy-check", { intent });
check("policy-check without a wallet is refused", r.status === 400);

// ---- 2. each wallet saves its own "savings"
const a = await setRecipient(alice, "savings", ALICE_SAVE);
check("alice saves 'savings'", a.res.status === 200 && a.res.body.recipients.savings === ALICE_SAVE, JSON.stringify(a.res));
r = await j(`/api/recipients?owner=${bob.address}`);
check("bob's book is still empty", r.status === 200 && Object.keys(r.body.recipients).length === 0);
r = await post("/api/policy-check", { intent, owner: bob.address });
check("bob cannot use alice's 'savings'", r.status === 422);
// The client signs the NORMALISED label (as the Settings page does); the server normalises what it receives.
const bts = Date.now();
const bsig = await bob.signMessage({ message: buildRecipientSetMessage(bob.address, "savings", BOB_SAVE, bts) });
const b = { res: await post("/api/recipients", { op: "set", owner: bob.address, label: "  Savings ", address: BOB_SAVE, signature: bsig, timestamp: bts }) };
// A signature over the un-normalised text is refused: the signed text must match exactly what is stored.
const tsU = Date.now() + 5;
const sigU = await bob.signMessage({ message: buildRecipientSetMessage(bob.address, "  Rent ", BOB_SAVE, tsU) });
const rU = await post("/api/recipients", { op: "set", owner: bob.address, label: "  Rent ", address: BOB_SAVE, signature: sigU, timestamp: tsU });
check("a signature over un-normalised text is refused", rU.status === 401, JSON.stringify(rU));
check("bob saves his own (label normalised)", b.res.status === 200 && b.res.body.recipients.savings === BOB_SAVE, JSON.stringify(b.res));

r = await post("/api/policy-check", { intent, owner: alice.address });
check("alice's rule resolves to alice's address", r.status === 200 && r.body.policy.recipient === ALICE_SAVE, JSON.stringify(r.body));
r = await post("/api/policy-check", { intent, owner: bob.address });
check("bob's rule resolves to bob's address", r.status === 200 && r.body.policy.recipient === BOB_SAVE, JSON.stringify(r.body));
check("no 'public demo address' flag any more", r.body.policy.recipientIsPublicDefault === undefined);

// ---- 3. recipient writes are bound to the signer, the label and the address
let ts = Date.now();
let sig = await bob.signMessage({ message: buildRecipientSetMessage(alice.address, "savings", BOB_SAVE, ts) });
r = await post("/api/recipients", { op: "set", owner: alice.address, label: "savings", address: BOB_SAVE, signature: sig, timestamp: ts });
check("bob cannot overwrite alice's recipient with his own signature", r.status === 401, JSON.stringify(r));
sig = await alice.signMessage({ message: buildRecipientSetMessage(alice.address, "savings", ALICE_SAVE, ts) });
r = await post("/api/recipients", { op: "set", owner: alice.address, label: "savings", address: BOB_SAVE, signature: sig, timestamp: ts });
check("a signature for one address does not authorise another", r.status === 401, JSON.stringify(r));
const replay = await post("/api/recipients", { op: "set", owner: alice.address, label: "savings", address: ALICE_SAVE, signature: a.signature, timestamp: a.ts });
check("a captured signed request cannot be replayed", replay.status === 409, JSON.stringify(replay));
const old = Date.now() - 10 * 60_000;
r = (await setRecipient(alice, "rent", ALICE_SAVE, old)).res;
check("a stale signature is refused", r.status === 401, JSON.stringify(r));
r = (await setRecipient(alice, "rent", "0x01aD5f069a436f67fDCED12babE12CD9e2C19Bb1")).res;
check("bad checksum is refused", r.status === 400 && /checksum/.test(r.body.reason), JSON.stringify(r));
r = (await setRecipient(alice, "rent", USDC)).res;
check("the token contract is refused as a recipient", r.status === 400, JSON.stringify(r));
r = (await setRecipient(alice, "<script>", ALICE_SAVE)).res;
check("a script-like label is refused", r.status === 400);

// ---- 4. register automations: filed under the wallet, invisible to others
const onchainId = "41";
ts = Date.now();
sig = await alice.signMessage({ message: buildRegisterMessage(onchainId, alice.address, ts) });
r = await post("/api/automations", { onchainId, owner: alice.address, userId: "demo", intent, signature: sig, timestamp: ts });
check("alice registers an automation", r.status === 200 && r.body.ok, JSON.stringify(r));
const id = r.body.automation?.id;
check("record is filed under alice's lower-case address, not 'demo'", id === `${alice.address.toLowerCase()}-41` && r.body.automation.userId === alice.address.toLowerCase(), id);
r = await j(`/api/automations?owner=${alice.address}`);
check("alice sees her automation", r.body.automations?.length === 1);
r = await j(`/api/automations?owner=${bob.address}`);
check("bob sees none of alice's", r.body.automations?.length === 0);
r = await j(`/api/automations?userId=demo`);
check("the old ?userId=demo listing is gone", r.status === 400);
r = await j(`/api/automations?id=${id}`);
check("lookup by id works", r.status === 200 && r.body.automations[0].id === id);

ts = Date.now();
sig = await bob.signMessage({ message: buildActionMessage(id, "pause", ts) });
r = await post("/api/execute", { automationId: id, action: "pause", signature: sig, timestamp: ts });
check("bob cannot pause alice's automation", r.status === 401, JSON.stringify(r));
ts = Date.now() + 1;
sig = await alice.signMessage({ message: buildActionMessage(id, "pause", ts) });
r = await post("/api/execute", { automationId: id, action: "pause", signature: sig, timestamp: ts });
check("alice can pause her own", r.status === 200 && r.body.status === "paused", JSON.stringify(r));
r = await post("/api/execute", { automationId: "nope", action: "pause", signature: sig, timestamp: ts });
check("unknown automation -> 404", r.status === 404);

// ---- 5. per-wallet cap (server started with MAX_AUTOMATIONS_PER_OWNER=1)
r = await post("/api/policy-check", { intent, owner: alice.address });
check("cap reached -> refused before anything is signed on-chain", r.status === 422 && /most this testnet allows/.test(r.body.reason), JSON.stringify(r));
r = await post("/api/policy-check", { intent, owner: bob.address });
check("the cap is per wallet (bob unaffected)", r.status === 200);
ts = Date.now() + 2;
sig = await alice.signMessage({ message: buildRegisterMessage("42", alice.address, ts) });
r = await post("/api/automations", { onchainId: "42", owner: alice.address, intent, signature: sig, timestamp: ts });
check("registration backstops the cap too", r.status === 422, JSON.stringify(r));

// ---- 6. removal
ts = Date.now() + 3;
sig = await alice.signMessage({ message: buildRecipientRemoveMessage(alice.address, "savings", ts) });
r = await post("/api/recipients", { op: "remove", owner: alice.address, label: "savings", signature: sig, timestamp: ts });
check("alice removes her recipient", r.status === 200 && !("savings" in r.body.recipients), JSON.stringify(r));
r = await j(`/api/recipients?owner=${bob.address}`);
check("bob's recipient is untouched", r.body.recipients.savings === BOB_SAVE);

// ---- 7. health
r = await j("/api/health");
check("health is ok and reports the executor as not configured here", r.status === 200 && r.body.ok === true && r.body.executor === "not-configured", JSON.stringify(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
