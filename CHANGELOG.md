# Changelog

## 2026-06-03 — Fix `/send` falsely reporting "NO REPORTS TO SUBMIT" (wiped Temp header)

The day after the 2026-06-02 gid fix made `/send` work end-to-end for the first time, a `/send`
(exec `6916`) answered **"⚠️ NO REPORTS TO SUBMIT — The Temp sheet is empty"** even though a report
had just been submitted from the tablet. The data was never lost — it was still staged in Temp.

### Root cause (proven from live exec 6916)

Path: `Read Temp Tab` → **returned 25 rows** → `Has Data?` (IF) → all routed to `Send Empty Message`
→ false "empty" reply, then a Telegram **429**. The 25 rows came out keyed by **dog data values**
(`"Holly Brett"`, `"lucycbrett@…"`, `"Lunch"`…) with `row_number` starting at **3** — n8n had
promoted the first *dog* row to column headers because **Temp row 1 (the header) was blank**. With no
`Dog Name` key on any row, the IF test `={{ $json['Dog Name'] }}` `notEmpty` was false for every row.

Why the header was gone: n8n's `Clear Temp Tab` / `Clear Temp (Cancel)` nodes used `operation:"clear"`
with the **default `clear:"wholeSheet"`**, which deletes row 1 too. Before the gid fix `/send` always
died at the read, so this clear had never actually run; the first successful run (exec `6833`,
2026-06-02 17:23) wiped the header. The next tablet submit then wrote dog rows at `getRange(2,1,…)`
(`submitReport`) **without recreating the header** (it assumed row 1 was permanent), leaving row 1
blank → n8n mis-read every subsequent cycle.

### Fixes (defense in depth)

1. **GAS self-heals the Temp header (primary).** New `ensureTempHeader_(sheet)` rebuilds row 1 (and
   re-seats stray dog rows) whenever it's missing; called at the top of `submitReport` and in
   `clearTempTab`. So even a whole-sheet wipe can't poison the next read. New `?action=repairTemp`
   doGet action runs it on demand. Header constant centralised as `CONFIG.TEMP_HEADER`. Verified with
   a Node harness against the real source (15 assertions: wiped-header, fast-path, empty tab, ragged
   rows, clear-then-heal). Deployed via clasp at **@17**.
2. **n8n clears stop deleting the header.** `Clear Temp Tab` (`01dc7c47…`) and `Clear Temp (Cancel)`
   (`645b2769…`) switched from `clear:"wholeSheet"` to `clear:"specificRange"`, range `A2:G1000`
   (live workflow updated via n8n MCP; `n8n_validate_workflow` 0 errors; this mirror regenerated).
3. **Recovery.** `?action=repairTemp` restored the header to the live Temp tab with today's 26 staged
   rows intact (incl. the first dog that had been eaten as the header), ready to re-`/send`.

## 2026-06-02 — Fix Telegram `/send` and `/cancel` (n8n workflow)

The Telegram review commands had **never** worked: staff would reply `/send` (to push the staged
JotForm rows) or `/cancel` (to discard them) and nothing happened, despite many "fix" iterations.
Investigation of the **live** n8n workflow `yaBIrDOVbJTEMsH9` ("Feeding Report - Send Command (v2
Real-Time Sync)") — its execution history, the GAS contract, the Sheet, and the JotForm form —
found the workflow was active and *receiving* the commands, but failing immediately downstream.

### Root cause (proven from execution errors 6443 / 6514 / 6823 / 6824)

Every Google Sheets node referenced its tab with `sheetName = { mode:"list", value:"Temp" }`. In
n8n's Sheets node, `mode:"list"` treats `value` as the numeric **gid**, so it searched for a sheet
whose *ID* was the string `"Temp"`, found none, and threw `Sheet with ID Temp not found`. This
killed `/send` (at *Read Temp Tab*), `/cancel` (at *Clear Temp (Cancel)*), and `/status` (at *Read
Temp (Status)*). The trigger, webhook, chat ID, and command parsing were all healthy; the only past
"success" executions were non-command messages that fell through the Switch to no branch. State was
never lost — the Temp tab is durable; n8n simply couldn't read it.

### Fixes (applied to the live workflow via the n8n MCP; mirrored here)

1. **Sheets tab references → gid.** All six Sheets nodes now use the real gids — Temp `1965265218`,
   Session `1038940935` (Lookup `0`, B/T pen `1567330092`, confirmed via the gviz CSV headers).
2. **JotForm EU endpoint.** The account is in **EU Safe mode**; `api.jotform.com` 301-redirects and
   drops the POST body. *Submit to JotForm* now posts to `eu-api.jotform.com`.
3. **JotForm body was empty.** The node had `specifyBody:"json"` (invalid for `form-urlencoded`)
   and **no body at all**. *Prepare JotForm Data* now emits a URL-encoded `bodyString`
   (`encodeURIComponent` over the `submission[...]` map) and the node sends `specifyBody:"string"`,
   `body={{ $json.bodyString }}`. Field IDs validated against the live form (3=date, 6=food,
   7=supplements, 9=meal, 10=has-medicine, 13=name, 14=email, 21=comments).
4. **Reply bot.** The four reply nodes (+ new *Send Unknown Command*) were sending via a different
   bot ("Route Planner Bot"); switched to **"Feeding report bot"** (the bot in the group / the
   trigger bot) and given an explicit `operation: sendMessage`.
5. **Command-match hardening.** The Switch rules changed from `contains` to `startsWith` (still
   matches the group form `/send@Bot`, but stray text like "don't /cancel" no longer fires), and a
   `fallbackOutput` now routes unrecognised commands to a *Send Unknown Command* hint reply.

### Verification

- Workflow validates clean (0 errors). The JotForm half was proven by replaying the node's exact
  request (EU endpoint + URL-encoded `submission[...]` body) — it returned a `submissionID` and the
  submission recorded every field correctly (test row used `k.singh3184@gmail.com`, deleted
  afterward). Confirmed live: execution **6833** — a real `/send` from the group — read the Temp
  tab, POSTed **12** JotForm submissions (12 × HTTP 200 on `eu-api`, 0 failures), cleared the Temp
  tab, and posted the ✅ summary back from the Feeding report bot. First successful command run ever.

## 2026-06-02 — "Add Dogs for Today": one-press board setup from the Whiteboard

Staff used to build each feeding session by hand (pick the meal, type every dog, drag each card into a pen). New **"Add Dogs for Today"** button on the tablet sidebar does it in one tap: it reads the meal period from the clock and pulls that meal's dogs from the **Whiteboard Display** project (a separate app on a different sheet), then merges them onto the board into pens.

### Backend — `feeding_report_backend_v2.js`

- New action **`getTodayPlan(mealPeriod)`** (wired into both `doGet` and `doPost`), plus helpers `getBoardingPlan_`, `getLunchPlan_`, `readPenMap_`, `fetchJson_`, `normName_`. Returns `{success, mealPeriod, today, dogs:[{name, penGroup}], skipped, counts}`; never throws to the client.
- **Breakfast / Dinner** source = the Whiteboard Boarding-Planner **check-in/out feed** (`?mode=checkinout`), which has reliable `checkIn`/`checkOut` dates (the raw whiteboard `Check_Out` cell is blank, so it can't be used). With `today` computed in `Europe/London`:
  - Breakfast (`Morning Meal`): `checkIn < today && checkOut >= today` — slept here last night; **includes** dogs leaving this morning (they check out after breakfast), **excludes** today's arrivals.
  - Dinner (`Evening Meal`): `checkIn <= today && checkOut > today` — here tonight; **includes** today's check-ins, **excludes** today's check-outs.
  - `type` ∈ {boarding, school} both count. Deduped by name, alphabetical, `penGroup:null` (any pen).
- **Lunch** source = the Whiteboard **today roster** (`?action=loadToday`), filtered to `Full Day`/`Half Day AM`/`Half Day PM`, then kept **only** if the dog is in the feeding sheet's pen tab (**gid `1567330092`**: `Dog Name | Pen Number | Size`) with `B`→`bottom` or `T`→`top`. Blank/absent pen → returned in `skipped`. `penGroup` drives the side.
- Cross-app reads are server-side `UrlFetchApp` (no browser CORS); the whiteboard URLs + check-in/out token live in `CONFIG` (already public in the Pages-hosted display, so no new secret).

### Frontend — `index.html`

- New **⚡ Quick Start → 🐶 Add Dogs for Today** button (sidebar). `computeMealPeriod()` maps the clock (<10:30 → Breakfast, 10:30–<14:00 → Lunch, ≥14:00 → Dinner) to the existing meal-type values.
- `addDogsForToday()` fetches `getTodayPlan`, sets the meal type, then **merges** (skips dogs already on the board by matched/typed name), and places each dog into the **least-occupied eligible pen** (all 10 for breakfast/dinner; the B/T side for lunch) so the spread stays even. Reuses `matchDogName`/`fuzzyMatchDogName` and `syncAddDog`; the pen is set in `pens` *before* `syncAddDog` so the queued `add` carries the penId (no extra update round-trip). Summary toast reports added / skipped-duplicates / skipped-no-pen / needs-name-match.

### Notes / follow-ups

- Name joins across Whiteboard / B-T tab / Lookup rely on matching "First Surname" spelling; mismatches surface as `skipped` or unmatched cards (never silently dropped).
- **Flagged (out of scope):** the feeding sheet is currently world-readable via the public `gviz` CSV endpoint (an unauthenticated fetch of the pen tab succeeded), exposing Lookup parent emails — lock the sheet sharing down separately. The backend-mediated design does not depend on it.



A max-effort code review of the 2026-04-29 release (`e01f722`) found that the snapshot-based reliability layer, despite its intent, still **silently lost data** in several ways. This release reworks the sync layer and closes all 15 findings. Both clients were redeployed live (GitHub Pages + GAS deployment `@14`); the deploy windows had an empty Session, so no in-progress feeding was disrupted.

### The core rework — `index.html`

The localStorage **snapshot** model (`saveLocalSnapshot` / `maybeRestoreLocalSnapshot`) is **removed entirely** and replaced with a **durable outbound mutation queue** (`mutationQueue`, key `feedingManager.queue.v1`):

- Every local edit is enqueued as `{op, dogId, payload}` (`op` ∈ `add|update|delete|mealType`). `sync*` are now thin enqueue wrappers; `flushQueue()` drains in order, removing an item only after its POST succeeds, and retries on the next cycle (dropping after 5 rejections so it can't wedge).
- **`applyRemoteState()` now MERGES** the server snapshot with the queue instead of wholesale-replacing `dogs`/`pens` — the server is authoritative only for dogs with no pending op (pending adds kept, updates re-applied, deletes suppressed). This is what stops the silent erase of offline edits on reconnect.
- The crash-recovery path is automatic: the queue persists across reloads, is merged into view (so unsynced dogs are visible offline), and flushes on reconnect — no `confirm()` prompt, no snapshot to overwrite.

### Connection handling — `index.html`

- All GAS calls go through **`gasFetch()`** (AbortController, 12s timeout) so slow/dead requests can't stack on flaky wifi; the 7s heartbeat gained an in-flight guard.
- The offline decision is **debounced**: `isOnline` is optimistic and flips false only after **2** consecutive failures (reset by any success). A single transient blip no longer raises the banner or blocks Submit.
- `updateConnectionUI()` is the single owner of the banner + Submit button; **Submit requires `isOnline && queue empty`**. The heartbeat ping only marks *reachable* + triggers a flush — it never clears the "unsynced" state by itself (it used to mask failed writes).
- Removed the redundant `consecutiveSyncFailures`/`lastSuccessfulSyncAt` state and the full-state snapshot writes.

### Backend — `feeding_report_backend_v2.js`

- **Telegram delivery is now gated:** free-text names are Markdown-escaped (`escapeTelegramMarkdown`), and `submitReport` only `clearSession()`s + returns `success:true` after a confirmed send; on failure it returns `{success:false, telegramSent:false}` and keeps Temp+Session for retry. (Previously an unbalanced `_`/`*` in a name 400'd the send, yet the session was wiped and success reported — total silent report loss.)
- `finalName` precedence changed to `matchedName || name || inputName` so a fuzzy-single-match dog reports its resolved name (and its parent email resolves) instead of the raw typed text.
- Per-dog fields are normalized at the top of the submit loop: `supplementTypes` coerced to an array (no more `.join` throw after the Temp tab was cleared) and `status` resolved via `hasOwnProperty` (unknown status defaults to `All` with a logged warning instead of a silent mis-map).

### Findings status (15 total)

- **Fixed & deployed:** #1–#13 (the six Critical, three High, and the false-offline/timeout #10 + backend-normalization #13 Mediums). #11/#12/#15 were largely resolved as a side-effect of the queue rework.
- **Moot:** #14 (server-side `new Date()` timezone) — the Apps Script manifest is `Europe/London`, correct for the business.
- **Cosmetic leftover:** #15 — read-path fetches not yet consolidated into one `postAction` wrapper.

### Verification & deploy

- Each change was verified by a headless Node harness that loads the **actual** source (the inline `<script>` via `new Function`, the GAS file with stubbed Apps Script globals) and runs the acceptance scenarios — offline-add-survives-reconnect, crash recovery, submit-gating, telegram-failure-keeps-dogs, delete-stays-deleted, the 2-strike debounce, `gasFetch`'s abort signal, and malformed-row normalization.
- Backend deployed via `clasp` (clone → overwrite `Code.js` → `push` → `redeploy` the existing deployment to keep the `/exec` URL); endpoint smoke-tested after each push. `index.html` shipped via GitHub Pages.

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
