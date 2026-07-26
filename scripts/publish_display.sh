#!/usr/bin/env bash
# One-command publish of the TV Feeding Display to the Fairytails123/frmdisplay
# Pages repo (the TV's URL: https://fairytails123.github.io/frmdisplay/).
#
#   bash scripts/publish_display.sh "commit message"
#   bash scripts/publish_display.sh --dry-run
#
# Pipeline: contract drift-check -> assemble (inject shared/contract.js into
# display/display.html, LF-normalised) -> clone frmdisplay -> overwrite
# index.html -> commit + push. Any failure aborts before the push.
# NOTE: the TV shows a long-lived page — it picks the new version up on its next
# browser refresh/restart, not instantly. Verify with ?cb=<timestamp>.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MSG="${1:-Update display}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

echo "== 1/4 contract drift-check =="
node "$REPO_DIR/scripts/check_contract.js"

echo "== 2/4 assemble =="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
node "$REPO_DIR/scripts/assemble_display.js" "$WORK_DIR/index.html"

if [ "$DRY_RUN" = "1" ]; then
  echo "== dry-run: stopping before clone/push. Assembled at $WORK_DIR/index.html =="
  head -c 400 "$WORK_DIR/index.html"; echo
  trap - EXIT   # keep the artifact for inspection
  echo "(work dir kept: $WORK_DIR)"
  exit 0
fi

echo "== 3/4 clone frmdisplay =="
git clone --depth 1 "https://github.com/Fairytails123/frmdisplay.git" "$WORK_DIR/frmdisplay"
cd "$WORK_DIR/frmdisplay"
git config user.name "Fairytails123"
git config user.email "Fairytails123@users.noreply.github.com"
cp "$WORK_DIR/index.html" index.html

if git diff --quiet -- index.html; then
  echo "No change vs the published page — nothing to push."
  exit 0
fi

echo "== 4/4 commit + push =="
git add index.html
git commit -m "$MSG"
git push origin HEAD

echo "Published. Verify (allow ~1-2 min Pages CDN):"
echo "  https://fairytails123.github.io/frmdisplay/?cb=$(date +%s)"
echo "Remember: the TV itself needs a browser refresh to pick this up."
