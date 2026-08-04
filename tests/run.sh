#!/usr/bin/env bash
# Run the whole verification suite. MUST pass before any deploy — see tests/README.md.
#   bash tests/run.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
run() {
  echo
  echo "══════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "══════════════════════════════════════════════════════════════"
  shift
  "$@" || fail=1
}

run "syntax — backend"   node --check feeding_report_backend_v2.js
run "contract drift"     node scripts/check_contract.js
run "backend (GAS)"      node tests/backend.test.js
run "tablet (index.html)" node tests/tablet.test.js
run "TV display"       node tests/display.test.js

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ ALL SUITES PASSED — safe to deploy"
else
  echo "❌ SOMETHING FAILED — do NOT deploy"
fi
exit "$fail"
