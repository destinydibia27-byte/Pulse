#!/usr/bin/env bash
# Starts the web app and the worker in one container (used by the Dockerfile).
#  - The web app is the main process. If it exits, the container exits and the platform restarts it.
#  - The worker is restarted after a pause if it crashes, so a bad setting there (for example a
#    missing executor key) shows up in the logs without taking the website down.
#  - Both share one store: Supabase when SUPABASE_URL and SUPABASE_SECRET_KEY are set (use this on a
#    host with no persistent disk), otherwise the JSON file at PULSE_DB_PATH (needs a persistent disk).
#  - On Render, a keep-alive loop requests this service's own public URL every 10 minutes. Render
#    counts that as inbound traffic; a request to localhost would not count. It is best effort: it
#    cannot wake a service that is already asleep, so also point an external uptime monitor at /api/health.
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SECRET_KEY:-}" ]; then
  echo "[hosted] storage: Supabase"
else
  export PULSE_DB_PATH="${PULSE_DB_PATH:-/data/automations.json}"
  mkdir -p "$(dirname "$PULSE_DB_PATH")" 2>/dev/null || true
  echo "[hosted] storage: JSON file at $PULSE_DB_PATH (lost on restart unless this path is a persistent disk)"
fi

(
  cd backend
  while true; do
    node --import tsx src/triggerWorker.ts
    echo "[hosted] worker exited with code $?; restarting in 15s"
    sleep 15
  done
) &
LOOP=$!

KEEPALIVE=""
if [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
  (
    sleep 90
    while true; do
      node -e 'fetch(process.env.RENDER_EXTERNAL_URL.replace(/\/+$/,"")+"/api/health",{signal:AbortSignal.timeout(20000)}).then(r=>console.log("[keepalive] "+r.status)).catch(e=>console.log("[keepalive] failed: "+e.message))'
      sleep 600
    done
  ) &
  KEEPALIVE=$!
fi

cleanup() {
  for p in "$LOOP" $KEEPALIVE; do kill "$p" 2>/dev/null; pkill -P "$p" 2>/dev/null; done
}
trap cleanup EXIT
trap 'exit 143' TERM INT

cd frontend
node scripts/run-with-env.js start -p "$PORT" -H 0.0.0.0
