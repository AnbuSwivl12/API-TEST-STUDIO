#!/usr/bin/env bash
# Tiny launcher for API Test Studio.
# Tries python3 → python → npx serve, in that order.
set -e
PORT="${PORT:-5173}"
URL="http://localhost:${PORT}/"

if command -v python3 >/dev/null 2>&1; then
  echo "▶ Serving on $URL  (Ctrl+C to stop)"
  ( sleep 1 && (open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true) ) &
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  echo "▶ Serving on $URL  (Ctrl+C to stop)"
  ( sleep 1 && (open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true) ) &
  exec python -m SimpleHTTPServer "$PORT"
else
  echo "▶ python not found — falling back to npx serve"
  exec npx --yes serve . -l "$PORT"
fi
