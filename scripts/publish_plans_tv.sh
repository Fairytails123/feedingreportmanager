#!/usr/bin/env bash
# One-command publish of the TV feeding-plans page to the Fairytails123/fooddata
# Pages repo (the TV's URL: https://fairytails123.github.io/fooddata/).
#
#   bash scripts/publish_plans_tv.sh "commit message"
#   bash scripts/publish_plans_tv.sh --dry-run
#
# Pipeline: contract drift-check -> stage the verbatim page and logo -> clone
# fooddata -> overwrite the payload -> commit + push. Any failure aborts before
# the push. The long-lived TV page updates only after a browser refresh/restart.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=0
MSG_PARTS=()
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  else
    MSG_PARTS+=("$arg")
  fi
done
if [ "${#MSG_PARTS[@]}" -eq 0 ]; then
  MSG="Update TV feeding plans"
else
  MSG="${MSG_PARTS[*]}"
fi

echo "== 1/4 contract drift-check =="
node "$REPO_DIR/scripts/check_contract.js"

echo "== 2/4 stage payload =="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
PAYLOAD_DIR="$WORK_DIR/payload"
mkdir -p "$PAYLOAD_DIR/assets/img"
cp "$REPO_DIR/tv-plans/index.html" "$PAYLOAD_DIR/index.html"
cp "$REPO_DIR/tv-plans/assets/img/logo.jpg" "$PAYLOAD_DIR/assets/img/logo.jpg"
INDEX_SHA256="$(sha256sum "$PAYLOAD_DIR/index.html" | awk '{print toupper($1)}')"

if [ "$DRY_RUN" = "1" ]; then
  echo "== dry-run: stopping before clone/push =="
  trap - EXIT
  echo "Staged payload retained for inspection: $PAYLOAD_DIR"
  echo "Staged index.html SHA-256: $INDEX_SHA256"
  exit 0
fi

echo "== 3/4 clone fooddata =="
git clone --depth 1 "https://github.com/Fairytails123/fooddata.git" "$WORK_DIR/fooddata"
cd "$WORK_DIR/fooddata"
git config user.name "Fairytails123"
git config user.email "Fairytails123@users.noreply.github.com"
mkdir -p assets/img
cp "$PAYLOAD_DIR/index.html" index.html
cp "$PAYLOAD_DIR/assets/img/logo.jpg" assets/img/logo.jpg

if [ -z "$(git status --porcelain -- index.html assets/img/logo.jpg)" ]; then
  echo "No change vs the published page — nothing to push."
  echo "Verify: https://fairytails123.github.io/fooddata/?cb=$(date +%s)"
  echo "Remember: the TV itself needs a manual browser refresh to pick this up."
  exit 0
fi

echo "== 4/4 commit + push =="
git add index.html assets/img/logo.jpg
git commit -m "$MSG"
git push origin HEAD

echo "Published. Verify (allow ~1-2 min Pages CDN):"
echo "  https://fairytails123.github.io/fooddata/?cb=$(date +%s)"
echo "Remember: the TV itself needs a manual browser refresh to pick this up."
