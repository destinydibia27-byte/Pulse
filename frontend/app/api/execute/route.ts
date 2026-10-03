import { NextRequest, NextResponse } from "next/server";
import {
  listAutomationsForUser,
  recordExecutionResult,
  setStatus,
  updateAutomation,
} from "../../../lib/db";
import { isValidTimeZone, localParts, markDone } from "../../../lib/scheduler";
import { buildActionMessage, verifyAuth } from "../../../lib/auth";
import { consumeOnce, sweepExpired } from "../../../lib/nonceGuard";

/**
 * Status changes (pause/resume/cancel) are recorded here AFTER the client has
 * already made the on-chain call and seen it confirm; the chain is the source of
 * truth and this database is only an index of it.
 *
 * Every action requires a fresh signature from the automation's OWNER wallet (not
 * just any wallet, and not the userId string, which is unauthenticated by itself).
 * Each signature can be used once. This bounds "fire" from being spammed by anyone
 * who can reach the endpoint; it does not replace the on-chain caps, which still
 * apply regardless.
 *
 * "fire" is a DEMO control that submits execute() immediately instead of waiting for the
 * worker. It no longer bypasses anything: the CONTRACT enforces the weekday (UTC), once per
 * UTC day, the balance condition and the caps, so firing on the wrong day or with the
 * condition unmet comes back as a rejection with the contract's own reason. To demo a
 * successful run, create the automation for today's UTC weekday. Set ENABLE_DEMO_FIRE=false
 * on any deployment other people can reach. A manual fire that actually sends counts as that
 * day's run, so the background worker won't repeat it; a rejected one does not, because the
 * contract didn't use up the day either.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { userId = "demo", automationId, action, signature, timestamp } = body as {
    userId?: string;
    automationId: string;
    action: "fire" | "pause" | "resume" | "cancel";
    signature?: `0x${string}`;
    timestamp?: number;
  };

  const automations = await listAutomationsForUser(userId);
  const automation = automations.find((a) => a.id === automationId);
  if (!automation) {
    return NextResponse.json({ ok: false, reason: "Automation not found." }, { status: 404 });
  }

  if (!signature || typeof timestamp !== "number") {
    return NextResponse.json({ ok: false, reason: "Missing signature or timestamp." }, { status: 401 });
  }
  // Verified against the RECORD's owner, never against the unauthenticated `userId`
  // string in the request body — that string is only a database lookup key here.
  const auth = await verifyAuth({
    message: buildActionMessage(automationId, action, timestamp),
    signature,
    expectedSigner: automation.owner,
    timestamp,
  });
  if (!auth.ok) return NextResponse.json({ ok: false, reason: auth.reason }, { status: 401 });
  sweepExpired();
  if (!consumeOnce(signature, timestamp + 5 * 60 * 1000)) {
    return NextResponse.json({ ok: false, reason: "This signed request was already used." }, { status: 409 });
  }

  if (action === "pause") {
    await setStatus(automationId, "paused");
    return NextResponse.json({ ok: true, status: "paused" });
  }
  if (action === "resume") {
    await setStatus(automationId, "active");
    return NextResponse.json({ ok: true, status: "active" });
  }
  if (action === "cancel") {
    await setStatus(automationId, "cancelled");
    return NextResponse.json({ ok: true, status: "cancelled" });
  }

  if (action === "fire") {
    if (process.env.ENABLE_DEMO_FIRE === "false") {
      return NextResponse.json({ ok: false, reason: "Manual firing is disabled." }, { status: 403 });
    }

    const countAsToday = () =>
      updateAutomation(automationId, (r) => {
        const tz = isValidTimeZone(r.timezone) ? r.timezone : "UTC";
        r.run = markDone(r.run, localParts(new Date(), tz).date);
      });

    const hasChainConfig =
      process.env.ARBITRUM_SEPOLIA_RPC_URL &&
      process.env.PULSE_CONTRACT_ADDRESS &&
      process.env.EXECUTOR_PRIVATE_KEY;

    if (!hasChainConfig) {
      // MOCK MODE: no live chain configured, so no real transaction happens.
      await recordExecutionResult(automationId, {
        status: "success",
        reason: "MOCK MODE: no RPC/executor configured, this was not a real transaction.",
      });
      await countAsToday();
      return NextResponse.json({
        ok: true,
        mock: true,
        message:
          "Executed in MOCK MODE. Configure ARBITRUM_SEPOLIA_RPC_URL, PULSE_CONTRACT_ADDRESS and EXECUTOR_PRIVATE_KEY for a real on-chain call.",
      });
    }

    const { attemptExecution, ExecutionUncertainError } = await import("../../../lib/chain");
    try {
      const { hash, outcome } = await attemptExecution(
        BigInt(automation.onchainId),
        BigInt(automation.amountBaseUnits)
      );

      if (outcome.status === "success") {
        await countAsToday();
        await recordExecutionResult(automationId, { status: "success", txHash: hash });
        return NextResponse.json({ ok: true, txHash: hash, outcome: "success" });
      }
      if (outcome.status === "rejected") {
        // Deliberately NOT counted as today's run: nothing was sent and the contract did not
        // consume the day, so the worker must stay free to send later today (e.g. once the
        // balance condition becomes true).
        await recordExecutionResult(automationId, { status: "rejected", txHash: hash, reason: outcome.reason });
        return NextResponse.json({ ok: true, txHash: hash, outcome: "rejected", reason: outcome.reason });
      }
      // Mined with no Executed/ExecutionRejected event (or reverted): outcome unknown, so
      // count the day to avoid any chance of a double send.
      await countAsToday();
      await recordExecutionResult(automationId, {
        status: "error",
        txHash: hash,
        error: `Unexpected outcome: ${outcome.status}`,
      });
      return NextResponse.json(
        { ok: false, txHash: hash, reason: `Unexpected outcome: ${outcome.status}` },
        { status: 502 }
      );
    } catch (err) {
      if (err instanceof ExecutionUncertainError) {
        await countAsToday(); // sent, unconfirmed: do not let the worker resend today
        await recordExecutionResult(automationId, {
          status: "error",
          txHash: err.hash,
          error: "Sent but not confirmed. Check the transaction.",
        });
        return NextResponse.json({ ok: false, txHash: err.hash, reason: "Sent but not confirmed." }, { status: 504 });
      }
      const msg = (err as Error).message.split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
      await recordExecutionResult(automationId, { status: "error", error: msg });
      return NextResponse.json({ ok: false, reason: msg }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, reason: "Unknown action." }, { status: 400 });
}
