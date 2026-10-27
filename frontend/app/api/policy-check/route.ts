import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import {
  resolvePolicy,
  checkRule,
  toBaseUnits,
  PolicyRejection,
  ApprovedRecipients,
} from "../../../lib/policyEngine";
import { readTokenBalance } from "../../../lib/balance";
import { IntentSchema } from "../../../lib/schema";
import { approvedRecipientsFor, USDC_ADDRESS } from "../../../lib/appConfig";
import { listAutomationsForUser } from "../../../lib/db";
import { maxAutomationsPerOwner, rateLimited, userKey } from "../../../lib/guard";

export async function POST(req: NextRequest) {
  const limited = rateLimited(req, "policyCheck");
  if (limited) return limited;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.owner !== "string" || !isAddress(body.owner)) {
    return NextResponse.json({ ok: false, reason: "Connect your wallet first." }, { status: 400 });
  }
  const owner = getAddress(body.owner);
  const parsedIntent = IntentSchema.safeParse(body.intent);
  if (!parsedIntent.success) {
    return NextResponse.json({ ok: false, reason: "Invalid intent payload." }, { status: 400 });
  }

  // The user is the wallet. The client cannot name a different user.
  const userId = userKey(owner);

  try {
    // Checked here, BEFORE the person signs anything on-chain, so a refusal never leaves an
    // on-chain permission that the app then declines to register.
    const live = (await listAutomationsForUser(userId)).filter((a) => a.status === "active" || a.status === "paused").length;
    if (live >= maxAutomationsPerOwner()) {
      return NextResponse.json(
        { ok: false, reason: `You already have ${live} automations, the most this testnet allows. Cancel one on the Dashboard first.` },
        { status: 422 }
      );
    }
    const policy = resolvePolicy(userId, parsedIntent.data, USDC_ADDRESS, await approvedRecipientsFor(userId));

    // "Check rule": well-formedness + a read of the balance RIGHT NOW.
    // Explicitly NOT a prediction of state at the future trigger time.
    const threshold = toBaseUnits(parsedIntent.data.condition.balance);
    const balanceRead = await readTokenBalance(owner, policy.asset);
    const result = checkRule(
      policy,
      balanceRead.status === "checked" ? balanceRead.balance : null,
      parsedIntent.data.condition.operator,
      threshold
    );

    return NextResponse.json({
      ok: true,
      policy: {
        asset: policy.asset,
        recipient: policy.recipient,
        amount: policy.amount.toString(),
        maxPerExecution: policy.maxPerExecution.toString(),
        maxPerWindow: policy.maxPerWindow.toString(),
        windowSeconds: policy.windowSeconds,
        expiresAt: policy.expiresAt,
        // Enforced on-chain by the contract (weekday in UTC; operator is the Op enum index).
        weekday: policy.weekday,
        conditionOp: policy.conditionOp,
        conditionThreshold: policy.conditionThreshold.toString(),
      },
      ruleCheck: result,
      balanceCheck:
        balanceRead.status === "checked"
          ? { status: "checked", balance: balanceRead.balance.toString() }
          : { status: "skipped", reason: balanceRead.reason },
      note: "This reflects your balance right now. It does not predict your balance when the automation actually triggers.",
    });
  } catch (err) {
    if (err instanceof PolicyRejection) {
      return NextResponse.json({ ok: false, reason: err.message }, { status: 422 });
    }
    throw err;
  }
}
