import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { getRecipients, setRecipient, removeRecipient } from "../../../lib/db";
import { buildRecipientRemoveMessage, buildRecipientSetMessage, verifyAuth } from "../../../lib/auth";
import { consumeOnce, sweepExpired } from "../../../lib/nonceGuard";
import { checkRecipientAddress, MAX_RECIPIENTS_PER_USER, normalizeLabel } from "../../../lib/recipients";
import { USDC_ADDRESS } from "../../../lib/appConfig";
import { rateLimited, userKey } from "../../../lib/guard";
import { verifySmartAccount } from "../../../lib/smartVerify";

/**
 * A wallet's saved recipients ("savings" -> 0x...). Reading needs no sign-in: the same addresses
 * become public on-chain the moment a permission uses them. LIMITATION: anyone who knows a wallet
 * address can read its book here; add wallet sign-in sessions before mainnet.
 * Writing requires a signature from the wallet that owns the book, bound to the exact label and
 * address (see buildRecipientSetMessage), so nobody can add or change a recipient for someone else.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimited(req, "list");
  if (limited) return limited;
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !isAddress(owner)) {
    return NextResponse.json({ ok: false, reason: "Pass ?owner=<wallet address>." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, recipients: await getRecipients(userKey(getAddress(owner))) });
}

const Body = z.object({
  op: z.enum(["set", "remove"]),
  owner: z.string().refine((v) => isAddress(v), "owner must be a valid address"),
  label: z.string(),
  address: z.string().optional(),
  // 65 bytes for a normal wallet; longer for a smart account (checked by verifyAuth).
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){65,4096}$/, "signature must be a valid hex signature"),
  timestamp: z.number(),
});

export async function POST(req: NextRequest) {
  const limited = rateLimited(req, "write");
  if (limited) return limited;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { op, signature, timestamp } = parsed.data;
  const owner = getAddress(parsed.data.owner);
  const label = normalizeLabel(parsed.data.label);
  if (!label) {
    return NextResponse.json(
      { ok: false, reason: "Names use 1 to 32 letters, numbers, spaces, dashes or underscores, and start with a letter or number." },
      { status: 400 }
    );
  }

  let address: `0x${string}` | undefined;
  if (op === "set") {
    const forbidden: { address: string; why: string }[] = [{ address: USDC_ADDRESS, why: "That is the USDC token contract. Money sent there is lost." }];
    if (process.env.PULSE_CONTRACT_ADDRESS) {
      forbidden.push({ address: process.env.PULSE_CONTRACT_ADDRESS, why: "That is the Volo contract itself. Money sent there is lost." });
    }
    const checked = checkRecipientAddress(parsed.data.address, forbidden);
    if (!checked.ok) return NextResponse.json({ ok: false, reason: checked.reason }, { status: 400 });
    address = checked.address;
  }

  // The signed text names the label and (for "set") the address exactly as the server will store them.
  const message =
    op === "set"
      ? buildRecipientSetMessage(owner, label, address!, timestamp)
      : buildRecipientRemoveMessage(owner, label, timestamp);
  const auth = await verifyAuth({ message, signature: signature as `0x${string}`, expectedSigner: owner, timestamp, verifySmartAccount });
  if (!auth.ok) return NextResponse.json({ ok: false, reason: auth.reason }, { status: 401 });
  sweepExpired();
  if (!consumeOnce(signature, timestamp + 5 * 60 * 1000)) {
    return NextResponse.json({ ok: false, reason: "This signed request was already used." }, { status: 409 });
  }

  const userId = userKey(owner);
  if (op === "set") {
    const book = await getRecipients(userId);
    if (!(label in book) && Object.keys(book).length >= MAX_RECIPIENTS_PER_USER) {
      return NextResponse.json({ ok: false, reason: `You can save up to ${MAX_RECIPIENTS_PER_USER} recipients. Remove one first.` }, { status: 422 });
    }
    await setRecipient(userId, label, address!);
  } else {
    await removeRecipient(userId, label);
  }
  return NextResponse.json({ ok: true, recipients: await getRecipients(userId) });
}
