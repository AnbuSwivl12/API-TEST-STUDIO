#!/usr/bin/env bash
# API Test Studio — local launcher.
# Starts:
#   • a static web server on http://localhost:5173 (the app)
#   • a CORS proxy        on http://localhost:5174 (forwards any method/url)
# Stops both with Ctrl+C.
set -e
WEB_PORT="${PORT:-5173}"
PROXY_PORT="${PROXY_PORT:-5174}"

cleanup() { kill 0; }
trap cleanup EXIT INT TERM

# ----- start the CORS proxy -----
if command -v node >/dev/null 2>&1; then
  PORT="$PROXY_PORT" node proxy.js &
  echo "▶ proxy:  http://localhost:$PROXY_PORT/?url=<target>"
else
  echo "✘ Node not found — proxy disabled. Install Node.js to test localhost APIs."
fi

# ----- start the static server -----
echo "▶ app:    http://localhost:$WEB_PORT"
( sleep 1.2 && (open "http://localhost:$WEB_PORT" 2>/dev/null || xdg-open "http://localhost:$WEB_PORT" 2>/dev/null || true) ) &

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$WEB_PORT"
elif command -v python >/dev/null 2>&1; then
  python -m SimpleHTTPServer "$WEB_PORT"
else
  npx --yes serve . -l "$WEB_PORT" --no-clipboard
fi
