import { NextRequest, NextResponse } from "next/server";
import { LlmUnavailableError, parseUserIntent } from "../../../lib/parser";
import { rateLimited } from "../../../lib/guard";

/**
 * Calls an OpenAI-compatible chat completions API (Groq by default). If no API key is set, falls
 * back to a tiny rule-based extractor so the app still runs end-to-end without any external
 * service. That fallback is clearly a placeholder, not a real parser.
 *
 * Settings (all server-side, never NEXT_PUBLIC):
 *   GROQ_API_KEY     turns the AI reader on
 *   GROQ_MODEL       model id. Default openai/gpt-oss-120b. Groq retired llama-3.3-70b-versatile on
 *                    2026-08-16, so check console.groq.com/docs/deprecations before changing it.
 *   GROQ_BASE_URL    default https://api.groq.com/openai/v1 (any OpenAI-compatible endpoint works)
 *   LLM_TIMEOUT_MS   default 25000
 *
 * Whatever goes wrong, the person sees a short generic message. The provider's own error text can
 * contain account details, so it is only written to the server log.
 */
const DEFAULT_MODEL = "openai/gpt-oss-120b";

async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return mockParse(user);
  }

  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const base = (process.env.GROQ_BASE_URL?.trim() || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) > 0 ? Number(process.env.LLM_TIMEOUT_MS) : 25_000;

  const body: Record<string, unknown> = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  // The gpt-oss models reason before answering. For simple field extraction, low effort is faster and cheaper.
  if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
    console.error(`[parse] AI request failed (${timedOut ? "timeout" : (e as Error).message})`);
    throw new LlmUnavailableError(
      timedOut ? "The AI reader took too long. Please try again." : "The AI reader could not be reached. Please try again in a moment."
    );
  }

  if (!res.ok) {
    // Keys are masked in case a provider ever echoes one back into its error text.
    const detail = (await res.text().catch(() => "")).slice(0, 300).replace(/\b(gsk_|sk-)[A-Za-z0-9_-]+/g, "$1***");
    console.error(`[parse] AI provider answered HTTP ${res.status} for model ${model}: ${detail}`);
    throw new LlmUnavailableError(
      res.status === 429
        ? "The AI reader is busy. Wait a few seconds and try again."
        : "The AI reader is not available right now. Please try again later."
    );
  }

  const data = await res.json().catch(() => null);
  return data?.choices?.[0]?.message?.content ?? "";
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
  const limited = rateLimited(req, "parse");
  if (limited) return limited;
  const { text } = await req.json().catch(() => ({}));
  if (!text || typeof text !== "string" || text.length > 1000) {
    return NextResponse.json({ ok: false, reason: "Describe the automation in up to 1000 characters." }, { status: 400 });
  }

  const result = await parseUserIntent(text, callLLM);
  if (!result.ok) {
    return NextResponse.json(result, { status: result.code === "llm_unavailable" ? 503 : 422 });
  }
  // Tell the client whether an AI model or the crude offline fallback read the text, so the
  // review screen can warn the user to check every field when it was the fallback.
  return NextResponse.json({ ...result, parser: process.env.GROQ_API_KEY ? "llm" : "offline" });
}
