#!/usr/bin/env bash
# Publish API Test Studio to GitHub Pages.
# Commits whatever changed (unless the tree is clean) and pushes main.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "You're on '$BRANCH'. GitHub Pages serves 'main' — switch branches first."
  exit 1
fi

MSG="${1:-Deploy API Test Studio}"

if [ -n "$(git status --porcelain -- index.html README.md package.json deploy.sh start.sh worker)" ]; then
  git add index.html README.md package.json deploy.sh start.sh worker
  git commit -m "$MSG"
else
  echo "Nothing new to commit — pushing current main."
fi

git push origin main

URL="https://anbuswivl12.github.io/API-TEST-STUDIO/"
cat <<EOF

  =====================================================
   Pushed. GitHub Pages rebuilds in ~30-60 seconds.

   Live URL: $URL
   Tip: hard-reload (Cmd+Shift+R) to skip the CDN cache.
  =====================================================

EOF
