# Changelog

## 2026-04-29 — Connection reliability & data-loss fix

Staff reported that the Feeding Report Manager (tablet) was "losing its connection" to the Feeding Display, silently caching changes locally, then failing on submit and losing all entered data. Investigation showed there is no direct connection — both apps are independent clients of a Google Apps Script (GAS) web app polling a shared `Session` sheet, and "lost connection" really meant "GAS calls are failing intermittently and the UI is silent about it." This release makes those failures loud, durable, and survivable.

### `feeding_report_backend_v2.js` (Google Apps Script)

- **`submitReport(data)` now trusts the tablet's POST body when present.** Previously it ignored `data.dogs` and re-read from the Session tab — so any local edits that hadn't synced to the sheet were lost on submit. New behaviour: if `data.dogs` is a non-empty array, use it as the source of truth; otherwise fall back to `getSessionState()` for legacy callers.
- **Robust `finalName` resolution.** Now `dog.matchedName || dog.inputName || dog.name || ''` so both POST-body and Session-tab shapes work; malformed rows are skipped with `return` instead of crashing the whole submit.
- Telegram payload, JotForm URL builder, Temp tab schema, `clearSession()`, and every other endpoint are byte-for-byte unchanged. n8n workflow not affected.

**Deployment:** new code pasted into the live Apps Script project (`Feeding manager`) and deployed as a new version. The web-app URL is unchanged.

### `index.html` (tablet UI)

- **Loud offline banner.** Full-width fixed-top red banner with a "Retry now" button, appears within ~7 seconds of any failed sync. Cannot be missed during a feeding session.
- **Active 7-second heartbeat.** Pings the lightweight `getSessionVersion` endpoint independently of the existing 5s poll loop, so connection loss is detected even mid-edit (when the regular poll is gated by `pendingDogIds`).
- **Sync-health tracking** (`markSyncFailure` / `markSyncSuccess`). Wired into every fetch call site: `pollForUpdates`, `loadSessionState`, `loadDogList`, `syncAddDog`, `syncUpdateDog`, `syncDeleteDog`, `syncMealType`, `syncClearSession`, `submitToBackend`. A single failed call flips the connection state to offline, surfaces the banner, and disables Submit. A success clears all of that and shows a "✓ Reconnected" toast.
- **Submit blocked while offline.** `#submitBtn` and `#confirmSubmitBtn` get the `disabled` attribute via `disableSubmitButton()`. `confirmSubmit()` also has a hard early-return on `!isOnline || consecutiveSyncFailures > 0` as belt-and-suspenders.
- **Submit payload widened.** `assignedDogs` now includes `inputName` and `matchedName` alongside `name`, so the GAS `finalName` resolver works regardless of which path the backend takes.
- **localStorage snapshot.** Saved at the top of every `sync*` mutation (key: `feedingManager.snapshot.v1`). On page load `maybeRestoreLocalSnapshot()` compares the snapshot against the freshly loaded session and, if there are dogs in the snapshot that aren't in the session, prompts the user to recover them and replays each through `syncAddDog`. Cleared after a successful submit and after `clearAll`.
- **Quiet sync variant.** `syncUpdateDog(id, updates, true)` skips the failure-counter bump. Used by `applyRemoteState`'s auto-rematch logic so a single bad sheet row can't flood the counter and trip the offline banner spuriously.
- **Drag-and-drop is untouched.** All touch handlers, drag state vars, the `is-dragging` body class, the `LONG_PRESS_DURATION` long-press timer, and the Android `touch-action` quirks are preserved verbatim. The new banner is `position: fixed` with its own z-index — it does not interfere with the in-progress drag layout or the body class toggle.

### What this does *not* fix

- **GAS soft quotas / cold starts.** This release makes the app *resilient* to GAS hiccups (offline banner, snapshot, replay) but doesn't eliminate them. If the offline banner appears regularly during normal use, that points at GAS rate-limit or 5xx patterns — investigate via the GAS execution dashboard.
- **Display staleness indicator.** The Feeding Display still has no "Last update X minutes ago — STALE" warning. Low priority; not part of this fix.
- **Concurrent multi-tablet edits with one offline.** The snapshot-restore model assumes a single tablet edits a feeding session at a time. If two tablets edit simultaneously while one is offline, on reconnect they could overwrite each other.

### Verification

- Both files parse cleanly (`new Function(...)` smoke test on the inline `<script>` and the GAS file).
- GAS deployed; staff confirmed "all good and works" after using it on a real session.
- Full verification matrix is documented at `.claude/plans/review-the-code-in-harmonic-beacon.md` (offline-detection, killer-scenario submit, crash recovery, submit-blocked-while-offline, drag-and-drop regression smoke test). The drag-and-drop smoke test on the actual tablet should be re-run if any drag/drop CSS or touch handler is later changed.

### Files in this folder

- `index.html` — tablet UI (offline-resilient).
- `feeding_report_backend_v2.js` — Google Apps Script source. **The deployed copy lives in the Apps Script project, not in this repo.** When you change this file, you must paste the new contents into the Apps Script editor and redeploy a new version for the change to go live.
- `n8n_workflow_v2_corrected.json` — n8n automation that reads the Temp tab and posts to JotForm. Unchanged in this release.
