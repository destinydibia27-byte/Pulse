import { NextResponse } from "next/server";
import { listAutomationsForUser, storageBackend } from "../../../lib/db";

// Never cached: an uptime monitor must reach the running server, and the database check must be real.
export const dynamic = "force-dynamic";

/**
 * Cheap health check for uptime monitors and for you after a deploy.
 * It reads the database once, so a 200 means the app is up AND can reach its storage.
 * Responses are deliberately generic: no keys, URLs or internal error text.
 */
export async function GET() {
  let backend: "supabase" | "file" | "misconfigured" = "file";
  try {
    backend = storageBackend();
    await listAutomationsForUser("__health__");
    return NextResponse.json({ ok: true, storage: backend }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[health] storage check failed:", (e as Error).message);
    return NextResponse.json(
      { ok: false, storage: backend, error: "storage unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
