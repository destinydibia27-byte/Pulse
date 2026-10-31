import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { getAutomationById, listAutomationsForUser, saveAutomation, type AutomationRecord } from "../../../lib/db";
import { IntentSchema } from "../../../lib/schema";
import {
  resolvePolicy,
  formatUsdc,
  PolicyRejection,
} from "../../../lib/policyEngine";
import { verifyPermissionOnChain } from "../../../lib/chain";
import { approvedRecipientsFor, USDC_ADDRESS, chainConfigured } from "../../../lib/appConfig";
import { maxAutomationsPerOwner, rateLimited, userKey } from "../../../lib/guard";
import { buildRegisterMessage, verifyAuth } from "../../../lib/auth";
import { verifySmartAccount } from "../../../lib/smartVerify";
import { consumeOnce, sweepExpired } from "../../../lib/nonceGuard";

/** Lists one wallet's automations. Anything here is also public on-chain, so no sign-in is needed to read. */
export async function GET(req: NextRequest) {
  const limited = rateLimited(req, "list");
  if (limited) return limited;
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const automation = await getAutomationById(id);
    return automation
      ? NextResponse.json({ automations: [automation] })
      : NextResponse.json({ ok: false, reason: "Automation not found." }, { status: 404 });
  }
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !isAddress(owner)) {
    return NextResponse.json({ ok: false, reason: "Pass ?owner=<wallet address> or ?id=<automation id>." }, { status: 400 });
  }
  const automations = await listAutomationsForUser(userKey(getAddress(owner)));
  return NextResponse.json({ automations });
}

const Body = z.object({
  onchainId: z.string().regex(/^\d+$/, "onchainId must be a non-negative integer string"),
  owner: z.string().refine((v) => isAddress(v), "owner must be a valid address"),
  intent: IntentSchema,
  // 65 bytes for a normal wallet; longer for a smart account (checked by verifyAuth).
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){65,4096}$/, "signature must be a valid hex signature"),
  timestamp: z.number(),
});

/**
 * Registers an automation AFTER the user has signed createPermission() on-chain.
 *
 * The schedule, condition, amount and expiry are all derived here from the validated
 * intent, never taken from the client as separate fields, and (when a chain is
 * configured) the on-chain permission is read back and must match exactly. The
 * background worker acts on this record, so it must describe a permission that
 * really exists, is active, and belongs to `owner`.
 *
 * Authentication is the wallet signature above, plus the on-chain read-back that the
 * permission really belongs to that wallet. Records are filed under the owner's address.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimited(req, "write");
  if (limited) return limited;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }
  const { onchainId, intent, signature, timestamp } = parsed.data;
  const owner = getAddress(parsed.data.owner);
  // The user IS the wallet. Whatever the client claims, records are filed under the signer's address.
  const userId = userKey(owner);

  // Proves the caller controls `owner`'s private key right now. This does NOT by
  // itself prove `owner` holds the on-chain permission — verifyPermissionOnChain
  // below checks that separately once a chain is configured.
  const auth = await verifyAuth({
    message: buildRegisterMessage(onchainId, owner, timestamp),
    signature: signature as `0x${string}`,
    expectedSigner: owner,
    timestamp,
    verifySmartAccount,
  });
  if (!auth.ok) return NextResponse.json({ ok: false, reason: auth.reason }, { status: 401 });
  sweepExpired();
  if (!consumeOnce(signature, timestamp + 5 * 60 * 1000)) {
    return NextResponse.json({ ok: false, reason: "This signed request was already used." }, { status: 409 });
  }

  // Always UTC, whatever the client sends. The contract enforces the weekday in UTC (it has no
  // reliable source of a user's timezone), so the off-chain schedule must read the same
  // calendar. A local zone here would make the worker attempt on days the chain then refuses.
  const timezone = "UTC";

  let policy;
  try {
    policy = resolvePolicy(userId, intent, USDC_ADDRESS, await approvedRecipientsFor(userId));
  } catch (err) {
    if (err instanceof PolicyRejection) {
      return NextResponse.json({ ok: false, reason: err.message }, { status: 422 });
    }
    throw err;
  }

  // Idempotent: never overwrite an existing record (it holds the worker's run state).
  const id = `${userId}-${onchainId}`;
  const mine = await listAutomationsForUser(userId);
  const existing = mine.find((a) => a.id === id);
  if (existing) return NextResponse.json({ ok: true, automation: existing, alreadyRegistered: true });
  // Backstop for the same limit policy-check applies before anything is signed on-chain.
  const live = mine.filter((a) => a.status === "active" || a.status === "paused").length;
  if (live >= maxAutomationsPerOwner()) {
    return NextResponse.json(
      { ok: false, reason: `You already have ${live} automations, the most this testnet allows. Cancel one on the Dashboard first.` },
      { status: 422 }
    );
  }

  let verified = false;
  if (chainConfigured()) {
    try {
      const check = await verifyPermissionOnChain(BigInt(onchainId), {
        owner,
        asset: policy.asset,
        recipient: policy.recipient,
        maxPerExecution: policy.maxPerExecution,
        maxPerWindow: policy.maxPerWindow,
        windowSeconds: BigInt(policy.windowSeconds),
        expiresAt: BigInt(policy.expiresAt),
        weekday: policy.weekday,
        conditionOp: policy.conditionOp,
        conditionThreshold: policy.conditionThreshold,
      });
      if (!check.ok) return NextResponse.json({ ok: false, reason: check.reason }, { status: 422 });
      verified = true;
    } catch {
      return NextResponse.json(
        { ok: false, reason: "Could not verify the permission on-chain right now. Try again." },
        { status: 502 }
      );
    }
  }
  // else: offline/demo mode, no chain configured, so nothing to verify against.

  const record: AutomationRecord = {
    id,
    onchainId,
    userId,
    label: `${formatUsdc(policy.amount)} USDC to ${intent.recipientId}`,
    recipientLabel: intent.recipientId,
    amountBaseUnits: policy.amount.toString(),
    owner,
    asset: policy.asset,
    trigger: { day: intent.trigger.day },
    condition: {
      operator: intent.condition.operator,
      thresholdBaseUnits: policy.conditionThreshold.toString(),
    },
    timezone,
    expiresAt: policy.expiresAt,
    status: "active",
    createdAt: new Date().toISOString(),
  };
  await saveAutomation(record);
  return NextResponse.json({ ok: true, automation: record, verified });
}
