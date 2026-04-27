#!/usr/bin/env bash
# Tiny launcher for API Test Studio.
# Tries python3 → python → npx serve, in that order.
# Auto-frees the port and falls back to a free one if needed.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 1) Pick a port. Default 5173, but bump to next free if busy.
DESIRED="${PORT:-5173}"
PORT_TO_USE="$DESIRED"

# Kill anything already listening on the desired port (macOS / Linux).
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti:"$DESIRED" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "Port $DESIRED was in use — freeing it."
    kill -9 $PIDS 2>/dev/null || true
    sleep 1
  fi
fi

# Helper: is a port free?
port_free() {
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -i:"$1" >/dev/null 2>&1
  else
    ! (echo > /dev/tcp/127.0.0.1/"$1") 2>/dev/null
  fi
}

# If still busy, bump up.
if ! port_free "$PORT_TO_USE"; then
  for p in 5174 5175 5176 8080 8081 3001 4000 8765; do
    if port_free "$p"; then PORT_TO_USE="$p"; break; fi
  done
fi

URL="http://localhost:${PORT_TO_USE}/"

cat <<EOF

  =====================================================
   API Test Studio
  -----------------------------------------------------
   Folder: $DIR
   URL:    $URL
   Stop:   Ctrl+C

   >>> Open this in your browser:  $URL  <<<
  =====================================================

EOF

# Auto-open browser shortly after the server starts.
(
  sleep 1.5
  if command -v open >/dev/null 2>&1; then
    open "$URL" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" 2>/dev/null || true
  fi
) &

# Pick the first available static-server.
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT_TO_USE" --bind 127.0.0.1
elif command -v python >/dev/null 2>&1; then
  exec python -m SimpleHTTPServer "$PORT_TO_USE"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve . -l "$PORT_TO_USE"
else
  echo ""
  echo "ERROR: need python3 or npx."
  echo "  Install Python:  https://www.python.org/downloads/"
  echo "  Or install Node: https://nodejs.org/"
  exit 1
fi
