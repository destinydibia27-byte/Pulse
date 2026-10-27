"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "./components/ui";

const MAX_LEN = 280;
const MIN_LEN = 12;
const CHAT_KEY = "volo.chat";
const PENDING_KEY = "pulse.pendingIntent"; // what the Review page reads

// Each of these is checked against the real parser (including the offline fallback) before shipping.
const EXAMPLES = [
  { title: "Weekly savings", text: "Every Friday, send $10 to my savings wallet when my balance is above $100." },
  { title: "Monday top-up", text: "Every Monday, send $25 to my savings wallet if my balance is above $500." },
  { title: "Sunday sweep", text: "Every Sunday, send $5 to my savings wallet when my balance is above $50." },
];

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; kind: "error"; text: string }
  | { id: string; role: "assistant"; kind: "summary"; explanation: string; offline: boolean; source: string };

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function Bubble({ from, tone = "normal", children }: { from: "user" | "assistant"; tone?: "normal" | "error"; children: React.ReactNode }) {
  const base = "max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-[15px] leading-relaxed sm:max-w-[80%]";
  if (from === "user") return <div className={`${base} ml-auto rounded-br-md bg-brand text-white`}>{children}</div>;
  return (
    <div
      className={`${base} rounded-bl-md border ${
        tone === "error" ? "border-red-300 bg-red-50 text-red-800" : "border-line bg-card text-navy shadow-card"
      }`}
    >
      {children}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Restore the conversation (so coming back from the Review page does not lose it), and honour
  // "Create a changed copy", which leaves a rule here as plain text to edit.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CHAT_KEY) ?? "[]");
      if (Array.isArray(saved)) setMsgs(saved.slice(-30));
    } catch {}
    const prefill = sessionStorage.getItem("volo.prefill");
    if (prefill) {
      setText(prefill.slice(0, MAX_LEN));
      sessionStorage.removeItem("volo.prefill");
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try { sessionStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-30))); } catch {}
  }, [msgs, restored]);

  // The composer grows with the text, up to about five lines.
  const resize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);
  useEffect(resize, [text, resize]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }, [msgs, thinking]);

  const started = msgs.some((m) => m.role === "user");
  const lastSummaryId = [...msgs].reverse().find((m) => m.role === "assistant" && m.kind === "summary")?.id;

  async function send() {
    const t = text.trim();
    if (thinking || !t) return;
    if (t.length < MIN_LEN) {
      setHint("Add a few more details so Volo can read it: the day, the amount, where it goes, and the condition.");
      return;
    }
    setHint(null);
    setMsgs((m) => [...m, { id: uid(), role: "user", text: t }]);
    setText("");
    setThinking(true);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const data = await res.json();
      if (!data.ok) {
        setMsgs((m) => [...m, { id: uid(), role: "assistant", kind: "error", text: data.reason ?? "I could not understand that request." }]);
      } else {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(data));
        setMsgs((m) => [
          ...m,
          { id: uid(), role: "assistant", kind: "summary", explanation: String(data.explanation ?? ""), offline: data.parser === "offline", source: t },
        ]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { id: uid(), role: "assistant", kind: "error", text: `I could not reach Volo: ${(e as Error).message}` }]);
    } finally {
      setThinking(false);
      inputRef.current?.focus();
    }
  }

  function startOver() {
    setMsgs([]);
    setText("");
    setHint(null);
    try { sessionStorage.removeItem(CHAT_KEY); sessionStorage.removeItem(PENDING_KEY); } catch {}
    inputRef.current?.focus();
  }

  function editSource(source: string) {
    setText(source.slice(0, MAX_LEN));
    setHint(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const canSend = text.trim().length > 0 && !thinking;

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-11rem)] w-full max-w-2xl flex-col">
      <div className="flex-1 space-y-3 pb-6 pt-2" role="log" aria-live="polite" aria-label="Conversation with Volo">
        {started && (
          <div className="flex justify-end">
            <button type="button" onClick={startOver} className="rounded-full px-3 py-1 text-xs font-semibold text-link hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric">
              Start over
            </button>
          </div>
        )}

        <Bubble from="assistant">What do you want to automate?</Bubble>

        {!started && (
          <div className="flex flex-wrap gap-2 pt-1" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.title}
                type="button"
                onClick={() => { setText(ex.text); setHint(null); inputRef.current?.focus(); }}
                className="rounded-full border border-line bg-card px-3.5 py-1.5 text-sm font-medium text-slate-700 transition hover:border-brand hover:bg-brand-soft hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric"
              >
                {ex.title}
              </button>
            ))}
          </div>
        )}

        {msgs.map((m) =>
          m.role === "user" ? (
            <Bubble key={m.id} from="user">{m.text}</Bubble>
          ) : m.kind === "error" ? (
            <Bubble key={m.id} from="assistant" tone="error">
              <span className="font-semibold">I couldn&apos;t build that.</span>
              <span className="mt-1 block text-sm">{m.text}</span>
            </Bubble>
          ) : (
            <Bubble key={m.id} from="assistant">
              <span className="block text-sm font-semibold text-slate-600">Here&apos;s what I understood</span>
              <span className="mt-1 block">{m.explanation}</span>
              {m.offline && (
                <span className="mt-2 block text-xs text-amber-900">
                  I read this with my basic offline reader, which can misread words like &ldquo;below&rdquo;. Check the condition on the next screen.
                </span>
              )}
              {m.id === lastSummaryId ? (
                <span className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => router.push("/review")} className="btn-primary !rounded-full !py-2">
                    Review &amp; approve
                  </button>
                  <button type="button" onClick={() => editSource(m.source)} className="btn-secondary !rounded-full !py-2">
                    Change it
                  </button>
                </span>
              ) : (
                <span className="mt-2 block text-xs text-muted">Replaced by a newer version below.</span>
              )}
              <span className="mt-2 block text-xs text-muted">Nothing is created until you approve in your wallet.</span>
            </Bubble>
          )
        )}

        {thinking && (
          <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-line bg-card px-4 py-3.5 shadow-card" role="status">
            <span className="sr-only">Volo is reading your request</span>
            {[0, 150, 300].map((d) => (
              <span key={d} className="h-2 w-2 rounded-full bg-slate-400 motion-safe:animate-bounce" style={{ animationDelay: `${d}ms` }} aria-hidden="true" />
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="sticky bottom-0 -mx-4 bg-surface/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur"
        onSubmit={(e) => { e.preventDefault(); send(); }}
        noValidate
      >
        {hint && <p role="alert" className="mb-2 px-2 text-xs font-medium text-red-700">{hint}</p>}
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 items-end rounded-3xl border border-line bg-card px-4 py-2.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-electric/60">
            <label htmlFor="message" className="sr-only">What do you want to automate?</label>
            <textarea
              id="message"
              ref={inputRef}
              rows={1}
              maxLength={MAX_LEN}
              value={text}
              onChange={(e) => { setText(e.target.value); if (hint) setHint(null); }}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter adds a line. Never send mid-composition (IME keyboards).
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
              }}
              placeholder="Describe your automation…"
              className="max-h-36 min-h-[1.75rem] w-full resize-none bg-transparent py-0.5 text-[15px] leading-relaxed text-navy placeholder:text-slate-400 focus:outline-none"
            />
            {text.length >= 200 && (
              <span className={`ml-2 shrink-0 pb-1 text-xs tabular-nums ${text.length >= MAX_LEN ? "font-semibold text-red-700" : "text-muted"}`}>
                {text.length}/{MAX_LEN}
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand text-white transition hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {thinking ? <Spinner /> : (
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                <path d="M3.4 11.2 20.2 3.6c.8-.4 1.6.4 1.2 1.2L13.8 21.6c-.4.9-1.7.8-2-.1l-1.9-6.6a1 1 0 0 0-.7-.7L2.6 12.3c-.9-.3-1-1.5.8-1.1z" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </main>
  );
}
