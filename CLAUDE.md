# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Feeding Report Manager** for a dog daycare/boarding operation. Staff use a tablet web app during a feeding session to log which dogs ate how much, plus medicine/supplements, by dragging dog cards into physical "pen" slots. On submit, the system emails-prefills a JotForm per dog and posts a review summary to a Telegram group; a human replies `/send` in Telegram and an n8n workflow pushes the staged data into JotForm.

There is **no build, test, or lint tooling** — this repo is three hand-edited source files plus a changelog. Editing any file requires a manual deployment step (see below); nothing here runs locally as a server.

**How changes get verified (the de-facto test step).** Because nothing runs locally, the established pattern before deploying is a *throwaway headless Node harness* that loads the **actual** source and replays acceptance scenarios — the inline `<script>` from `index.html` is extracted and evaluated with `new Function`, and `feeding_report_backend_v2.js` is loaded with the Apps Script globals (`SpreadsheetApp`, `UrlFetchApp`, `Utilities`, etc.) stubbed. Scenarios proven this way include offline-add-survives-reconnect, crash recovery, submit-gating on Telegram failure, delete-stays-deleted, and malformed-row normalization (see the 2026-06-02 `CHANGELOG.md` entry). Verify against real source this way **before** the live deploy — do not hand-deploy unverified edits.

## The four moving parts (most live outside this repo)

1. **`index.html`** — the tablet UI. A single self-contained HTML file (inline CSS + JS, no framework, no bundler). Deployed via **GitHub Pages** (this repo). Committing to `main` publishes it.
2. **`feeding_report_backend_v2.js`** — Google Apps Script (GAS) web app. **The deployed copy lives in the Apps Script project named "Feeding manager", NOT in this repo** (it is container-bound to the Sheet; its single live code file is `Code.js`). This file is a *source mirror*; deploy it with **`clasp`** (see Deployment below). The web-app `/exec` URL stays constant across versions.
3. **`n8n_workflow_v2_corrected.json`** — the n8n automation ("Feeding Report - Send Command (v2 Real-Time Sync)"), **live workflow ID `yaBIrDOVbJTEMsH9`** on `ftmanager.app.n8n.cloud`. Triggered by Telegram commands `/send`, `/cancel`, `/status`. Reads the Temp tab, submits each row to JotForm, clears tabs, replies to Telegram. Lives in n8n, not here — this JSON is a *mirror*; edit the live workflow with the **n8n MCP** (`n8n_update_partial_workflow`). See **"n8n command handler"** below for the config gotchas that kept it silently broken until 2026-06-02.
4. **Google Sheet** (`SHEET_ID` `1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc`) with three tabs — the shared state bus between all parts:
   - **Lookup** (permanent): `Dog Name | Parent Email | Parent Name`. Source of truth for dogs and emails.
   - **Session** (real-time sync, 12 cols): live editing state shared across tablets. Schema in the GAS `CONFIG.SESSION_COLS`.
   - **Temp** (7 cols): submission staging that n8n reads. `Dog Name | Parent Email | Meal | Food Consumed | Medicine Supplement | Supplement Types | Comments`.

## Critical architecture fact: there is no direct device-to-device connection

The tablet UI and any Feeding Display are **independent clients of the same GAS web app**, each polling the shared **Session** sheet. "Lost connection" in user reports means *GAS calls are failing intermittently*, not a socket dropping.

### Sync model — durable outbound mutation queue (read this before touching sync code)

The 2026-06-02 rework replaced the old localStorage-*snapshot* reliability layer with a **persisted outbound mutation queue** (`mutationQueue`, localStorage key `feedingManager.queue.v1`). Every local edit is an `{op, dogId, payload}` where `op` ∈ `add | update | delete | mealType`. The `sync*` functions are thin wrappers that **enqueue** and call `flushQueue()`; the queue (not the call site) owns ordering, retry, and offline persistence. Invariants to preserve:

- `flushQueue()` drains in order, removing an item only after its POST succeeds; it stops on the first failure and retries next cycle (drops an item after 5 rejections so it can't wedge).
- `applyRemoteState()` **merges** the server snapshot with the queue — the server is authoritative *only* for dogs with no pending op (pending adds kept, updates re-applied, deletes suppressed). It must **never** wholesale-replace `dogs`/`pens`; that was the original silent-data-loss bug.
- Connection state: `isOnline` is optimistic and flips false only after `OFFLINE_THRESHOLD` (2) consecutive failures (debounces flaky wifi). All GAS calls go through `gasFetch()` (AbortController, `FETCH_TIMEOUT_MS` 12s). The 7s heartbeat (`getSessionVersion`) has an in-flight guard and only marks *reachable* + triggers a flush — it never clears the "unsynced" state by itself.
- `updateConnectionUI()` is the **single owner** of the banner + Submit-button state; **Submit is enabled only when `isOnline && queue empty`.**
- There is no longer any localStorage *snapshot* or `maybeRestoreLocalSnapshot` — the queue is the durable store. Don't reintroduce them, and don't add `if(!isOnline) return` early-returns back into the `sync*` functions.

The 2026-06-02 `CHANGELOG.md` entry documents the rework and which review findings each piece closes.

## Data flow on submit (the happy path)

1. Tablet `confirmSubmit()` → `submitToBackend()` POSTs `{action:'submitReport', dogs:[...], mealType, date}` to GAS.
2. GAS `submitReport(data)` — **trusts `data.dogs` from the POST body when non-empty** (the tablet's in-memory view is authoritative because local edits may not have reached the Session sheet). Falls back to `getSessionState()` only for legacy/empty callers. Writes the Temp tab, builds a prefilled JotForm URL per dog, posts the Telegram summary grouped by pen, and **only `clearSession()` + returns `success:true` after a confirmed Telegram delivery** — on a send failure it returns `{success:false, telegramSent:false}` and keeps Temp+Session intact for retry.
3. Human reviews the Telegram message and replies `/send` (or `/cancel`).
4. n8n reads the Temp tab, POSTs each row to JotForm, clears Temp (and Session on cancel), replies with a count.

`finalName` resolution in `submitReport` is `dog.matchedName || dog.name || dog.inputName || ''` (prefers the tablet's resolved `name` over the raw typed `inputName`); `status` and `supplementTypes` are normalized at the top of the loop so a malformed row can't silently mis-map or throw after the Temp tab is cleared. Free-text names are Markdown-escaped (`escapeTelegramMarkdown`) before the Telegram send. The frontend (`confirmSubmit`) treats a submit as successful only when `result.success && result.telegramSent`, and preserves the queue/board otherwise.

## n8n command handler (`/send` `/cancel` `/status`) — config gotchas

The Telegram review commands are handled by the **live n8n workflow `yaBIrDOVbJTEMsH9`** (edit via the **n8n MCP** `n8n_update_partial_workflow`, not by hand; the repo JSON is a mirror — regenerate it from the live workflow after any change). `Telegram Trigger` → `Command Router` (Switch on `message.text`): `/send` reads the **Temp** tab and POSTs each row to JotForm, `/cancel` clears **Temp + Session**, `/status` reports pending counts. These were silently broken from launch until 2026-06-02 (every real command errored at the first Google Sheets node while non-command chatter "succeeded" by falling through to no branch). Preserve these invariants — each is a fix for a bug that shipped to production:

- **Google Sheets nodes select the tab by gid, not name.** With the Sheet resource-locator in `mode:"list"`, `value` MUST be the numeric **gid** (`cachedResultName` is just a display label). Putting the tab *name* in `value` throws `Sheet with ID Temp not found`. Gids: **Temp `1965265218`, Session `1038940935`** (Lookup `0`, B/T pen `1567330092`). GAS, by contrast, addresses tabs by name (`getSheetByName`) — so a tab can exist and work for GAS yet be "missing" to a misconfigured n8n node.
- **JotForm is in EU Safe mode → use `eu-api.jotform.com`.** Plain `api.jotform.com` 301-redirects and drops the POST body. The submit node sends `form-urlencoded` `submission[<qid>]=…` as a URL-encoded `bodyString` built in the *Prepare JotForm Data* code node (`specifyBody:"string"`, not `"json"`). Question IDs on form `240143730611039`: `3` date, `6` food, `7` supplements (multi), `9` meal, `10` has-medicine, `13` name, `14` email, `21` comments.
- **Reply nodes use the "Feeding report bot" credential** (`QGWk6jRMWIlPH8Jz`, bot id `8436854999`, @YourDaycare_FeedingBot) — the same bot GAS posts the summary with and the only bot in group `-1003653235960`. Don't point replies at any other bot; set an explicit `operation: sendMessage`.
- **Command match is `startsWith`** (still matches the group form `/send@Bot`), with a `fallbackOutput` → *Send Unknown Command* reply for unrecognised text. The **Temp tab is durable state** — GAS writes it, only n8n clears it; nothing is lost between posting the links and the human replying.

## "Add Dogs for Today" — Whiteboard integration (`getTodayPlan`)

The tablet's **⚡ Quick Start → 🐶 Add Dogs for Today** button (`addDogsForToday()` in `index.html`) auto-populates the board for the current meal. It calls the backend action **`getTodayPlan(mealPeriod)`**, which pulls the roster from the **separate Whiteboard Display project** (different GAS web apps, a different sheet — `1kQsNXee…` Staff Board — *not* this feeding sheet). All cross-app reads are **server-side `UrlFetchApp`** (no browser CORS); the whiteboard URLs + check-in/out token live in `CONFIG`.

- **Meal period** comes from the tablet clock (`computeMealPeriod`): `<10:30` → `Morning Meal`, `10:30–<14:00` → `Lunch`, `≥14:00` → `Evening Meal`. `today` is computed **backend-side in `Europe/London`**.
- **Breakfast / Dinner** (`getBoardingPlan_`) read the Boarding-Planner **check-in/out feed** (`CONFIG.CHECKINOUT_URL` `?mode=checkinout&token=…`) — the **only** reliable source of `checkIn`/`checkOut` dates (the whiteboard's raw `Check_Out` cell is blank; `loadToday` omits dogs leaving this morning). Filters: breakfast `checkIn < today && checkOut >= today` (incl. dogs leaving this morning, excl. today's arrivals); dinner `checkIn <= today && checkOut > today` (incl. today's check-ins, excl. today's check-outs). `type` ∈ {boarding, school} both count. Dates are ISO so string comparison is correct.
- **Lunch** (`getLunchPlan_`) reads the whiteboard **today roster** (`CONFIG.WHITEBOARD_TODAY_URL` `?action=loadToday`), keeps `Full Day`/`Half Day AM`/`Half Day PM`, then keeps **only** dogs present in the feeding sheet's pen tab (**gid `CONFIG.BT_PEN_GID` = 1567330092**, columns `Dog Name | Pen Number | Size`) with `B`→`bottom` or `T`→`top`. The tab is read by **gid, not name**, via `getSheets().filter(s => s.getSheetId() === …)` (`readPenMap_`). Blank/absent pen → `skipped`.
- The handler returns `{success, mealPeriod, today, dogs:[{name, penGroup:'top'|'bottom'|null}], skipped, counts}`. The frontend **merges** (skips names already on the board), sets the meal type, and assigns each dog to the **least-occupied eligible pen** (`pickLeastOccupiedPen` — all 10 pens for breakfast/dinner; the B/T side for lunch), so the spread balances even on a non-empty board. Pen membership is set in `pens` **before** `syncAddDog` so the queued `add` carries the penId.
- **Name joins** across Whiteboard / B-T tab / Lookup use `normName_` (lowercase, trim, collapse spaces, **fold curly apostrophes** `’→'`) and rely on "First Surname" spelling agreement; mismatches surface as `skipped` (lunch) or unmatched cards (staff pick) — never silently dropped.
- **🔗 Cross-project contract — read before changing either side.** The two endpoints above are **owned by the separate White Board project**, on disk at `..\White Board\` (sibling folder under `…\CODING\`; its `CLAUDE.md` + `HANDOVER.md` are the producer-side docs, and the endpoints + sheet schema are listed in White Board `CLAUDE.md` → "Backends" / "Shared contracts"). This app is a **read-only downstream consumer** and depends on:
  - check-in/out feed (`?mode=checkinout`): `stays[].{dogName, checkIn, checkOut, type}` and the **`checkOut = day after the last booked night`** semantics (breakfast/dinner date filters break if this changes);
  - `?action=loadToday`: `dogs[].{name, serviceType}` and the exact `serviceType` strings (`Full Day` / `Half Day AM` / `Half Day PM` / `Boarding` / `Boarding School`);
  - the shared token `ft-k9-board-2024-sec`;
  - dog-name spelling agreement across the Whiteboard roster, the B/T tab, and Lookup (the join key).
  Changing any of those in the White Board project silently breaks "Add Dogs for Today" — update both sides together. The two systems use **different Google Sheets** (feeding `1Ejjoo55…`; White Board Staff Board `1kQsNXee…`); only the B/T tab (gid `1567330092`) lives in *this* sheet.

## Conventions and gotchas specific to this codebase

- **Communication with GAS is action-dispatch over a single endpoint.** `doGet` switches on `?action=` (`getDogList`, `getSession`, `getSessionVersion`, `getTodayPlan`); `doPost` switches on `data.action` (`addDog`, `updateDog`, `deleteDog`, `setMealType`, `submitReport`, `clearSession`, `getTemp`, `clearTemp`, `getTodayPlan`). Every handler returns `{success, ...}` or `{success:false, error}` — never throws to the client. Use `redirect: 'follow'` on fetches (GAS 302-redirects).
- **Session versioning is loose.** `getSessionState()` returns `version: new Date().getTime()` (always fresh), so the poll's `version > lastSyncVersion` gate is effectively always true and `applyRemoteState` runs every ~5s cycle — the **queue merge**, not the version gate, is what protects unsynced edits. The lightweight `getSessionVersion` (used by the heartbeat) returns the real max `Last_Updated`.
- **Defensive JSON parse is mandatory.** Session cells holding arrays (`Possible_Matches`, `Supplement_Types`) go through `safeJsonParse(value, fallback)` so one corrupt cell can't break `getSessionState()` for every device. Keep that pattern for any new JSON-bearing column.
- **Dog name matching is two-tier and lives in the frontend.** `matchDogName` (exact first-name + surname-initial prefix) for the primary match; `fuzzyMatchDogName` (scored, top 15) for the "possible matches" picker. The Lookup tab is the only name source; if it returns 0/few dogs all matching silently fails (GAS logs a warning).
- **Drag-and-drop is fragile and tablet-tuned.** Touch + mouse handlers, a `LONG_PRESS_DURATION` long-press timer, the `is-dragging` body class, and Android `touch-action` quirks are deliberately hand-balanced. The offline banner is `position:fixed` specifically so it never reflows the drag layout. If you change any drag/drop CSS or touch handler, re-run the on-tablet drag smoke test.
- **The `sync*` functions now just enqueue** (`syncAddDog/UpdateDog/DeleteDog/MealType`) and trigger a flush; the trailing `quiet` arg is accepted for call-site compatibility but ignored. Mutations are durable and replayed on reconnect.
- **Pen IDs are fixed strings:** `top-1`…`top-5`, `bottom-1`…`bottom-5`. Meal types: `Morning Meal`, `Lunch` (default), `Evening Meal`. The Telegram summary orders pens by a hardcoded `penOrder` array — update it if pen IDs change.

## Telegram URL encoding (project-wide rule)

When building any URL that a mobile Telegram user will tap, **emit zero `%XX` sequences** — iOS Telegram double-encodes them and breaks the target app. This backend's `mobileEncode()` already converts `%20`→`+` and unescapes `@ : /`. See the user-level memory note on the Telegram-iOS issue #138 workaround before adding any new outbound link.

## Secrets currently in source

`feeding_report_backend_v2.js` contains a live `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `JOTFORM_ID`, and `SHEET_ID` inline in `CONFIG`. They are committed. The `n8n_workflow_v2_corrected.json` mirror likewise carries the JotForm `apiKey` and the Telegram `chat_id` inline. Don't add more, and flag if asked to rotate them (the bot token in particular is sensitive).

## Deployment checklist when you change a file

- **`index.html`** → `git push origin main`; GitHub Pages serves it (CDN cache ~1–2 min; cache-bust with `?cb=<ts>` when verifying). No other step.
- **`feeding_report_backend_v2.js`** → deploy with **clasp** (already authenticated via `~/.clasprc.json`): in a throwaway temp dir run `clasp clone-script <scriptId>`, `cp` this file over the cloned `Code.js`, `clasp push -f`, then `clasp redeploy <deploymentId> -d "…"` to push a new version onto the **existing web-app deployment** (same `/exec` URL). Do **not** `clasp deploy` fresh — that mints a new URL the tablet doesn't use. The script ID + deployment ID are in Claude's private project memory (`feeding-manager-deploy`) and in Apps Script → Project Settings. Verify with `curl ".../exec?action=getSessionVersion"`. **Network ops (git push, clasp, curl) require the Bash tool's sandbox disabled.**
- **`n8n_workflow_v2_corrected.json`** → edit the **live workflow `yaBIrDOVbJTEMsH9`** in n8n via the **n8n MCP** (`n8n_update_partial_workflow`, surgical diff ops; run with `validateOnly:true` first), then regenerate this mirror from the live workflow (`n8n_get_workflow`). The JSON here is a mirror, not the source of truth. After editing, `n8n_validate_workflow` should report 0 errors; confirm a real command landed via the execution log (`n8n_executions`). See "n8n command handler" above before touching the Sheets/JotForm/Telegram nodes.
