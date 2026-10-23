#!/usr/bin/env bash
# Starts the web app and the worker in one container (used by the Dockerfile).
#  - The web app is the main process. If it exits, the container exits and the platform restarts it.
#  - The worker is restarted after a pause if it crashes, so a bad setting there (for example a
#    missing executor key) shows up in the logs without taking the website down.
#  - Both read/write the same file: PULSE_DB_PATH, which must be on a persistent volume.
set -u
cd "$(dirname "$0")/.."

export PULSE_DB_PATH="${PULSE_DB_PATH:-/data/automations.json}"
mkdir -p "$(dirname "$PULSE_DB_PATH")"
PORT="${PORT:-3000}"
echo "[hosted] database file: $PULSE_DB_PATH"

(
  cd backend
  while true; do
    node --import tsx src/triggerWorker.ts
    echo "[hosted] worker exited with code $?; restarting in 15s"
    sleep 15
  done
) &
LOOP=$!

cleanup() { kill "$LOOP" 2>/dev/null; pkill -P "$LOOP" 2>/dev/null; }
trap cleanup EXIT
trap 'exit 143' TERM INT

cd frontend
node scripts/run-with-env.js start -p "$PORT" -H 0.0.0.0
