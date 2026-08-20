#!/usr/bin/env bash
# Read-only comparison of the live boarding Apps Script with its audited deploy vehicle.
set -euo pipefail

SCRIPT_ID="12ZBH5zualFVdVz23pmC7orrqcf6wyUA8YbXKa6kR3kxm4T4KdBubh5gM"
BOARDINGPLAN_URL="https://github.com/Fairytails123/Boardingplan.git"

if ! command -v clasp >/dev/null 2>&1; then
  if [ "${BOARDING_STRICT:-0}" = "1" ]; then
    echo "!!! BOARDING DRIFT CHECK: ERROR — clasp is unavailable and BOARDING_STRICT=1 !!!" >&2
    exit 2
  fi

  echo "!!! BOARDING DRIFT CHECK: SKIPPED — clasp is unavailable; live equality was not checked !!!"
  echo "    Install and authenticate clasp, then rerun with BOARDING=1."
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "!!! BOARDING DRIFT CHECK: ERROR — git is unavailable, so Boardingplan cannot be cloned !!!" >&2
  exit 2
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

live_dir="$tmp_dir/live"
vehicle_dir="$tmp_dir/Boardingplan"
mkdir -p "$live_dir"

echo "BOARDING DRIFT CHECK: cloning the live Apps Script read-only..."
if ! (cd "$live_dir" && clasp clone-script "$SCRIPT_ID"); then
  echo "!!! BOARDING DRIFT CHECK: ERROR — failed to clone the live Apps Script; check network access and clasp authentication !!!" >&2
  exit 1
fi

echo "BOARDING DRIFT CHECK: cloning the Boardingplan deploy vehicle..."
if ! git clone --depth 1 "$BOARDINGPLAN_URL" "$vehicle_dir"; then
  echo "!!! BOARDING DRIFT CHECK: ERROR — failed to clone the Boardingplan deploy vehicle; check network access !!!" >&2
  exit 1
fi

live_file=""
while IFS= read -r -d '' candidate; do
  if [ -n "$live_file" ]; then
    echo "!!! BOARDING DRIFT CHECK: ERROR — the live clone contains more than one candidate source file !!!" >&2
    exit 1
  fi
  live_file="$candidate"
done < <(find "$live_dir" -type f ! -name 'appsscript.json' ! -name '.clasp.json' -print0)

if [ -z "$live_file" ]; then
  echo "!!! BOARDING DRIFT CHECK: ERROR — the live clone contains no candidate source file !!!" >&2
  exit 1
fi

vehicle_file="$vehicle_dir/src/supersetplanner-feed.gs"
if [ ! -f "$vehicle_file" ]; then
  echo "!!! BOARDING DRIFT CHECK: ERROR — Boardingplan/src/supersetplanner-feed.gs is missing !!!" >&2
  exit 1
fi

# Normalise CRLF to LF, remove trailing spaces/tabs on every line, and ignore
# trailing blank lines. awk writes one final LF on both sides, avoiding the
# permanent false difference caused when Apps Script strips the final newline.
normalise() {
  awk '
    {
      sub(/\r$/, "")
      sub(/[ \t]+$/, "")
      lines[NR] = $0
    }
    END {
      last = NR
      while (last > 0 && lines[last] == "") last--
      for (i = 1; i <= last; i++) print lines[i]
    }
  ' "$1" > "$2"
}

live_normalised="$tmp_dir/live.normalised.gs"
vehicle_normalised="$tmp_dir/vehicle.normalised.gs"
normalise "$live_file" "$live_normalised"
normalise "$vehicle_file" "$vehicle_normalised"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "!!! BOARDING DRIFT CHECK: ERROR — no SHA-256 utility is available !!!" >&2
    return 1
  fi
}

live_sha="$(sha256_of "$live_normalised")"
vehicle_sha="$(sha256_of "$vehicle_normalised")"
echo "Live Apps Script SHA-256:          $live_sha"
echo "Boardingplan deploy SHA-256:      $vehicle_sha"

if cmp -s "$live_normalised" "$vehicle_normalised"; then
  echo "BOARDING DRIFT CHECK: OK — live matches the deploy vehicle"
  exit 0
fi

echo "!!! BOARDING DRIFT CHECK: DRIFT — live Apps Script and Boardingplan/src/supersetplanner-feed.gs differ !!!" >&2
echo "!!! Reconcile by treating the live Apps Script as truth: clone it into a scratch directory, review the difference, and update Boardingplan through its guarded workflow. Never overwrite live from an unverified local copy. !!!" >&2
exit 1
