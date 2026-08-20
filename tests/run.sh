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

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo
  echo "!!! TV FEEDING-PLANS HARNESS — SKIPPED: powershell.exe is unavailable !!!"
else
  tv_plans_probe_output="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/tv-plans/build_and_run.ps1 -Validate 2>&1)"
  tv_plans_probe_status=$?
  if [ "$tv_plans_probe_status" -eq 0 ]; then
    run "TV feeding plans (20 scenarios)" powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/tv-plans/build_and_run.ps1
  elif [ "$tv_plans_probe_status" -eq 1 ] && printf '%s\n' "$tv_plans_probe_output" | node -e '
    const lines = require("fs").readFileSync(0, "utf8").split(/\r?\n/);
    const missing = lines.some((line) => {
      try { return JSON.parse(line).chromeFound === false; } catch { return false; }
    });
    process.exit(missing ? 0 : 1);
  '; then
    echo
    echo "!!! TV FEEDING-PLANS HARNESS — SKIPPED: Google Chrome is unavailable !!!"
  else
    echo
    echo "!!! TV FEEDING-PLANS HARNESS — FAILED: validation probe exited $tv_plans_probe_status !!!"
    echo "Probe output:"
    if [ -n "$tv_plans_probe_output" ]; then
      printf '%s\n' "$tv_plans_probe_output"
    else
      echo "(no output)"
    fi
    fail=1
  fi
fi

# The n8n session API is NOT a file in this repo — nothing above can see it break. It is opt-in
# because it writes to the REAL board (it refuses to run if a feeding round is in progress).
if [ "${LIVE:-0}" = "1" ]; then
  run "LIVE n8n session API" node tests/live_api.test.js
else
  echo
  echo "══════════════════════════════════════════════════════════════"
  echo "  LIVE n8n session API — SKIPPED"
  echo "══════════════════════════════════════════════════════════════"
  echo "  The live board lives in n8n (workflow hdGUbrd0PffVnwDS), not in this repo, so"
  echo "  nothing above can catch it breaking. Two @36 bugs proved that mattered — a"
  echo "  clearSession that validated clean and silently did nothing, and a sheet mirror"
  echo "  that raced itself into duplicate rows."
  echo
  echo "  ⚠  AFTER ANY CHANGE TO THE n8n WORKFLOW, run:   LIVE=1 bash tests/run.sh"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ ALL SUITES PASSED — safe to deploy"
  [ "${LIVE:-0}" = "1" ] || echo "   (offline suites only — see the LIVE note above)"
else
  echo "❌ SOMETHING FAILED — do NOT deploy"
fi
exit "$fail"
