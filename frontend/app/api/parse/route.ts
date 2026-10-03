import { NextRequest, NextResponse } from "next/server";
import { parseUserIntent } from "../../../lib/parser";

/**
 * Calls Groq (OpenAI-compatible chat completions API). If no API key is
 * set, falls back to a tiny rule-based extractor so the demo still runs
 * end-to-end without external network access — clearly a placeholder,
 * not a real parser.
 */
async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return mockParse(user);
  }

  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "{}";
}

/** MOCK MODE — only used when GROQ_API_KEY isn't set, for offline demoing. */
function mockParse(user: string): string {
  const amountMatch = user.match(/\$?(\d+(\.\d+)?)/g) ?? [];
  const amount = amountMatch[0]?.replace("$", "") ?? "10";
  const threshold = amountMatch[1]?.replace("$", "") ?? "100";
  const dayMatch = /monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.exec(user);
  const day = (dayMatch?.[0] ?? "friday").toLowerCase();
  const recipientMatch = /to (my |the )?([a-z\s]+?) wallet/i.exec(user);
  const recipientId = (recipientMatch?.[2] ?? "savings").trim().toLowerCase();

  const oneYear = new Date();
  oneYear.setFullYear(oneYear.getFullYear() + 1);

  return JSON.stringify({
    trigger: { type: "schedule", frequency: "weekly", day },
    condition: { asset: "USDC", operator: ">", balance: threshold },
    action: { type: "transfer", asset: "USDC", amount },
    recipientId,
    maxPerExecution: amount,
    maxPerWindow: amount,
    expiresAt: oneYear.toISOString(),
  });
}

export async function POST(req: NextRequest) {
  const { text } = await req.json();
  if (!text || typeof text !== "string") {
    return NextResponse.json({ ok: false, reason: "Missing 'text'." }, { status: 400 });
  }

  const result = await parseUserIntent(text, callLLM);
  if (!result.ok) {
    return NextResponse.json(result, { status: 422 });
  }
  return NextResponse.json(result);
}
