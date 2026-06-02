# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Feeding Report Manager** for a dog daycare/boarding operation. Staff use a tablet web app during a feeding session to log which dogs ate how much, plus medicine/supplements, by dragging dog cards into physical "pen" slots. On submit, the system emails-prefills a JotForm per dog and posts a review summary to a Telegram group; a human replies `/send` in Telegram and an n8n workflow pushes the staged data into JotForm.

There is **no build, test, or lint tooling** — this repo is three hand-edited source files plus a changelog. Editing any file requires a manual deployment step (see below); nothing here runs locally as a server.

## The four moving parts (most live outside this repo)

1. **`index.html`** — the tablet UI. A single self-contained HTML file (inline CSS + JS, no framework, no bundler). Deployed via **GitHub Pages** (this repo). Committing to `main` publishes it.
2. **`feeding_report_backend_v2.js`** — Google Apps Script (GAS) web app. **The deployed copy lives in the Apps Script project named "Feeding manager", NOT in this repo** (it is container-bound to the Sheet; its single live code file is `Code.js`). This file is a *source mirror*; deploy it with **`clasp`** (see Deployment below). The web-app `/exec` URL stays constant across versions.
3. **`n8n_workflow_v2_corrected.json`** — the n8n automation ("Feeding Report - Send Command (v2 Real-Time Sync)"). Triggered by Telegram commands `/send`, `/cancel`, `/status`. Reads the Temp tab, submits to JotForm, clears tabs, replies to Telegram. Lives in n8n, not here.
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

## Conventions and gotchas specific to this codebase

- **Communication with GAS is action-dispatch over a single endpoint.** `doGet` switches on `?action=` (`getDogList`, `getSession`, `getSessionVersion`); `doPost` switches on `data.action` (`addDog`, `updateDog`, `deleteDog`, `setMealType`, `submitReport`, `clearSession`, `getTemp`, `clearTemp`). Every handler returns `{success, ...}` or `{success:false, error}` — never throws to the client. Use `redirect: 'follow'` on fetches (GAS 302-redirects).
- **Session versioning is loose.** `getSessionState()` returns `version: new Date().getTime()` (always fresh), so the poll's `version > lastSyncVersion` gate is effectively always true and `applyRemoteState` runs every ~5s cycle — the **queue merge**, not the version gate, is what protects unsynced edits. The lightweight `getSessionVersion` (used by the heartbeat) returns the real max `Last_Updated`.
- **Defensive JSON parse is mandatory.** Session cells holding arrays (`Possible_Matches`, `Supplement_Types`) go through `safeJsonParse(value, fallback)` so one corrupt cell can't break `getSessionState()` for every device. Keep that pattern for any new JSON-bearing column.
- **Dog name matching is two-tier and lives in the frontend.** `matchDogName` (exact first-name + surname-initial prefix) for the primary match; `fuzzyMatchDogName` (scored, top 15) for the "possible matches" picker. The Lookup tab is the only name source; if it returns 0/few dogs all matching silently fails (GAS logs a warning).
- **Drag-and-drop is fragile and tablet-tuned.** Touch + mouse handlers, a `LONG_PRESS_DURATION` long-press timer, the `is-dragging` body class, and Android `touch-action` quirks are deliberately hand-balanced. The offline banner is `position:fixed` specifically so it never reflows the drag layout. If you change any drag/drop CSS or touch handler, re-run the on-tablet drag smoke test.
- **The `sync*` functions now just enqueue** (`syncAddDog/UpdateDog/DeleteDog/MealType`) and trigger a flush; the trailing `quiet` arg is accepted for call-site compatibility but ignored. Mutations are durable and replayed on reconnect.
- **Pen IDs are fixed strings:** `top-1`…`top-5`, `bottom-1`…`bottom-5`. Meal types: `Morning Meal`, `Lunch` (default), `Evening Meal`. The Telegram summary orders pens by a hardcoded `penOrder` array — update it if pen IDs change.

## Telegram URL encoding (project-wide rule)

When building any URL that a mobile Telegram user will tap, **emit zero `%XX` sequences** — iOS Telegram double-encodes them and breaks the target app. This backend's `mobileEncode()` already converts `%20`→`+` and unescapes `@ : /`. See the user-level memory note on the Telegram-iOS issue #138 workaround before adding any new outbound link.

## Secrets currently in source

`feeding_report_backend_v2.js` contains a live `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `JOTFORM_ID`, and `SHEET_ID` inline in `CONFIG`. They are committed. Don't add more, and flag if asked to rotate them (the bot token in particular is sensitive).

## Deployment checklist when you change a file

- **`index.html`** → `git push origin main`; GitHub Pages serves it (CDN cache ~1–2 min; cache-bust with `?cb=<ts>` when verifying). No other step.
- **`feeding_report_backend_v2.js`** → deploy with **clasp** (already authenticated via `~/.clasprc.json`): in a throwaway temp dir run `clasp clone-script <scriptId>`, `cp` this file over the cloned `Code.js`, `clasp push -f`, then `clasp redeploy <deploymentId> -d "…"` to push a new version onto the **existing web-app deployment** (same `/exec` URL). Do **not** `clasp deploy` fresh — that mints a new URL the tablet doesn't use. The script ID + deployment ID are in Claude's private project memory (`feeding-manager-deploy`) and in Apps Script → Project Settings. Verify with `curl ".../exec?action=getSessionVersion"`. **Network ops (git push, clasp, curl) require the Bash tool's sandbox disabled.**
- **`n8n_workflow_v2_corrected.json`** → import/update in n8n via the n8n MCP; the JSON here is a mirror.
