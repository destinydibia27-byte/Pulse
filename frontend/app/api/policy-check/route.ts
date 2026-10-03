import { NextRequest, NextResponse } from "next/server";
import {
  resolvePolicy,
  checkRule,
  toBaseUnits,
  PolicyRejection,
  ApprovedRecipients,
} from "../../../lib/policyEngine";
import { readTokenBalance } from "../../../lib/balance";
import { IntentSchema } from "../../../lib/schema";
import { APPROVED_RECIPIENTS, USDC_ADDRESS } from "../../../lib/appConfig";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsedIntent = IntentSchema.safeParse(body.intent);
  if (!parsedIntent.success) {
    return NextResponse.json({ ok: false, reason: "Invalid intent payload." }, { status: 400 });
  }

  const userId = body.userId ?? "demo";

  try {
    const policy = resolvePolicy(userId, parsedIntent.data, USDC_ADDRESS, APPROVED_RECIPIENTS);

    // "Check rule": well-formedness + a read of the balance RIGHT NOW.
    // Explicitly NOT a prediction of state at the future trigger time.
    const threshold = toBaseUnits(parsedIntent.data.condition.balance);
    const balanceRead = await readTokenBalance(body.owner, policy.asset);
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
