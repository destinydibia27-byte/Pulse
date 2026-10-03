#!/usr/bin/env bash
# The backend worker and the Next.js app share these modules. The source of truth is
# backend/src; frontend/lib holds byte-identical copies (Next can't import across the
# project boundary without extra build config). Run this after editing any of them.
#   scripts/sync-shared.sh          copy backend/src -> frontend/lib
#   scripts/sync-shared.sh --check  fail (exit 1) if any copy has drifted
set -euo pipefail
cd "$(dirname "$0")/.."
FILES=(schema policyEngine parser db abi chain scheduler auth nonceGuard)
status=0
for f in "${FILES[@]}"; do
  if [ "${1:-}" = "--check" ]; then
    if ! diff -q "backend/src/$f.ts" "frontend/lib/$f.ts" >/dev/null 2>&1; then
      echo "DRIFT: frontend/lib/$f.ts differs from backend/src/$f.ts"; status=1
    fi
  else
    cp "backend/src/$f.ts" "frontend/lib/$f.ts"; echo "synced $f.ts"
  fi
done
[ "${1:-}" = "--check" ] && [ $status -eq 0 ] && echo "shared modules in sync"
exit $status
