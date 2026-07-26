# Changelog

## 2026-07-06 — Submit 401 fixed: GAS Script Property updated to the rotated bot token (@27→@28)

**Reported:** every tablet submit failed with `❌ Submit failed: Telegram delivery failed:
{"ok":false,"error_code":401,"description":"Unauthorized"}` — the submit-gating worked as designed
(Temp + Session preserved, dogs kept on the board), but no report could go out.

**Root cause:** the Feeding bot token was **rotated on 2026-07-05** (scam-bot scare; old token
revoked at BotFather). The new token was put into the VPS n8n credential (`uMLzq2C84fMZqZPj`) but
the token's **second home — the GAS `TELEGRAM_BOT_TOKEN` Script Property** on the "Feeding manager"
script — was never updated, so `sendTelegramSummary` kept calling Telegram with the revoked token.
No code bug; a rotation-checklist gap.

**Fix (no lasting code change):** deployed a temporary nonce-guarded `__rotateTelegramToken` doPost
action (@27), called it once to set the Script Property (verified live — test message 612 delivered
to the Feeding Reports group via the same sendMessage path that was 401ing), then removed the temp
action and redeployed clean (@28; `getSessionVersion` OK, temp action confirmed gone). The
backend source in this repo is byte-identical to what was live before (drift-checked at clone time).

**Prevention:** `_SECRETS\telegram-bots.md` and CLAUDE.md ("Residual exposure") now both warn that
the Feeding token lives in TWO places — the n8n credential AND the GAS Script Property — and any
rotation must update both.

## 2026-06-19 — Lunch "Add Dogs" gates ALL dogs on "Lunch Y?" + owner-surname name-join, deployed @26

**Reported:** at lunch, `Oliver` was missing from the pens even though the master "Jot form Dog
Details" sheet gives him pen **B** and **Lunch Y = Y**; meanwhile `Ruby Jones`, `Ziggy Jones`,
`Rocco`, `Barney Homewood`, `Dolly` were added despite having **no** `Y` in the Lunch column.

**Two root causes** (verified against the live master sheet + `getTodayPlan('Lunch')`):
1. **Day-care ignored "Lunch Y?".** Before today, day-care lunch eligibility was *pen alone* —
   "Lunch Y?" only gated boarding guests (@25). So the five day-care dogs with a pen but no `Y` were
   added by design; the owner expects `Y` to control the lunch board for everyone.
2. **Name-join mismatch dropped Oliver.** The whiteboard roster lists him as `Oliver / Ollie Reed`
   (Full Day) but the master dog-name cell is just `Oliver` (owner surname `Reed` lives in the
   "Last Name (Excel)" column). Exact `normName_` missed, and the first+last fallback indexed the
   master row as `oliver|oliver` (single-token name), so roster `oliver|reed` never matched → no pen
   → `skipped`, not added. The same bug silently dropped `Alan Jones` (master `Alan`, pen T + Lunch Y).

**Clarified intent: "Lunch Y?" is the staff opt-in for the lunch PEN-FILL window (who appears on the
board at lunch) — NOT the report, which is still sent later on submit.**

### Code (`feeding_report_backend_v2.js`, deployed @26)
- **`getLunchPlan_`** — lunch pen-fill now requires `Lunch Y = Y` **AND** a B/T pen for **every**
  roster dog (day-care and boarding alike). No `Y` → not added; `Y` + no pen → `skipped`. The
  day-care-vs-boarding eligibility split is gone (service type still only filters *presence* today).
- **`readPenMap_`** — now also resolves the **owner surname** ("Last Name (Excel)") column by header
  (`"last name"`, fallback `LASTNAME_COL_FALLBACK_INDEX` = 7 / col H) and indexes every row under
  **both** dog-name first|last **and** dog-first-name|owner-surname keys (deduped per row so the
  `count === 1` ambiguity guard stays honest). Bridges `Oliver / Ollie Reed` ↔ `Oliver`, `Alan
  Jones` ↔ `Alan`.
- **CONFIG:** added `LASTNAME_COL_FALLBACK_INDEX: 7`.

### Verification
A headless harness loaded the actual edited source with GAS globals stubbed, fed the **live** master
CSV + whiteboard roster, and ran `getTodayPlan('Lunch')`: 18 eligible / 0 skipped — Oliver added
(bottom), the five named dogs excluded, Alan Jones recovered (top). Confirmed identical on the
**live** deployment after redeploy @26 (`getSessionVersion` → `success:true`; live `getTodayPlan('Lunch')`
matched the harness exactly). Note this also now excludes `Sonny Jalal` + `Rita Crocker` (day-care,
pen, no `Y`) — set their "Lunch Y?" if they should appear at lunch.

## 2026-06-16 — Lunch now includes boarding guests flagged "Lunch Y", deployed @25

`Millie Cartwright` was **dropped from lunch** in "Add Dogs for Today" even though the master
"Jot form Dog Details" sheet gives her a **Top** pen and marks **Lunch Y = Y**. Root cause: she's a
**boarding** guest today (whiteboard `serviceType: "Boarding"`), and `getLunchPlan_` kept **only**
day-care service types (`Full Day` / `Half Day AM` / `Half Day PM`) — so boarding dogs were filtered
out **before** the pen lookup and weren't even surfaced in `skipped` (which only collects *penless
day-care* dogs). Every boarding/boarding-school dog (Winnie, Poppy, Rocco, Millie, Rolo) was excluded
the same way. Confirmed across all three live sources (roster `serviceType`, master sheet pen+flag,
and the live `getTodayPlan('Lunch')` showing her in neither `dogs` nor `skipped`).

Boarding / Boarding School dogs are now added at lunch **only when** the master sheet's **"Lunch Y?"**
column = `Y` (opt-in) **AND** the row gives a `B`/`T` pen. Without the flag a boarding dog stays
excluded (its meals remain breakfast + dinner via the check-in/out feed); flagged-but-penless →
`skipped` for visibility. **Day-care lunch is unchanged — "Lunch Y?" is NOT consulted for day-care
dogs (pen alone decides), so there's no regression.**
_(Superseded 2026-06-19 / @26: "Lunch Y?" now gates **all** dogs incl. day-care — see the top entry.)_

### Code (`feeding_report_backend_v2.js`, deployed @25)

- **CONFIG:** added `LUNCH_COL_FALLBACK_INDEX` (`11` = col L = `Lunch Y?`).
- **`readPenMap_`** now resolves the **"Lunch Y?"** column by header (matches `"lunch"`, falls back to
  col L / index 11 with a loud warning) and returns a `lunchY` map (`normName → true` for `Y`/`YES`),
  plus a `lunchY` flag on each `firstLast` fallback entry so the tolerant name join carries it too.
- **`getLunchPlan_`** adds a `BOARDING` set (`Boarding`, `Boarding School`); the loop now keeps
  day-care **or** boarding rows. Day-care path is byte-equivalent (pen → `dogs`, else `skipped`).
  Boarding path: no `Lunch Y` flag → silent `continue`; flag + pen → `dogs`; flag + no pen → `skipped`.

### Verification

- **Headless Node harness** against the real source, replaying today's **live** roster + master sheet
  plus synthetic edge cases — **26/26 checks**: `Millie Cartwright → top`; a boarding dog with a pen
  but **no** flag (`Rolo Barnwell`) stays excluded; flagged-but-penless boarding dog → `skipped`; a
  day-care dog with `Lunch Y` but no pen (`April Neve-Jones`) **still skips** (flag ignored for
  day-care); counts, dedup, and top-before-bottom sort all correct.
- **Live after redeploy `@25`:** `getTodayPlan?mealPeriod=Lunch` eligible **13 → 14**,
  `Millie Cartwright → top`, `skipped` unchanged at 13 (no boarding dog wrongly surfaced).
- No sheet edits — fix is contained to this app; the master shared with the routes/van projects is untouched.

**Operational note:** the master sheet's **"Lunch Y?" column now controls whether a *boarding* dog gets
a lunch report.** To add another boarding guest at lunch, set their `Lunch Y? = Y` + a `T`/`B` pen.

## 2026-06-16 — Lunch cutoff moved 10:30 → 10:00

"Add Dogs for Today" now treats **10:00** (was 10:30) as the Morning→Lunch boundary, so pressing
**Add Dogs** at/after 10:00 adds the **lunch** roster instead of breakfast/boarding dogs.

- **`index.html` `computeMealPeriod()`** — boundary changed from `mins < 10*60+30` to `mins < 10*60`
  (`<10:00` → `Morning Meal`, `10:00–<14:00` → `Lunch`, `≥14:00` → `Evening Meal`). 14:00 dinner
  boundary unchanged. The backend (`getTodayPlan`) just acts on the meal string the tablet sends —
  no backend change. Verified against real source: 09:59 → Morning, 10:00/10:01/13:59 → Lunch,
  14:00 → Evening. Frontend-only → deploys via `git push` (GitHub Pages).

## 2026-06-09 — Lunch pen join: tolerant first+last name fallback, deployed @24

`Branko Rubi Steene` (booked Full Day, pen `B` in the master sheet) was being **skipped** at lunch.
Root cause: a pure name mismatch on the join key — the whiteboard roster carries his owner's
middle/maiden name (`Branko Rubi Steene`) while the master pen sheet stores `Branko Steene`, so the
exact `normName_` join missed and his pen `B` was never found. An audit of today's 7 skips confirmed
this was the **only** real miss (the other 6 are genuinely blank-pen, correctly skipped).

- **`readPenMap_`** now also returns a `firstLast` index (`"first|last" → {side, count}` over every
  named row). **`getLunchPlan_`** falls back to a first-name+last-name-token match when the exact join
  fails — used **only** when first+last resolves to exactly one pen-bearing master dog (`count === 1`),
  so an ambiguous collision declines rather than mis-assigning. Handles a middle/maiden name or nickname
  on **either** side; exact matches and blank-pen skips are unchanged.
- **Verified:** Node harness (16/16 — Branko fixed both directions, exact still works, blank stays
  skipped, ambiguity guard declines, boarding filtered). Live after redeploy `@24`:
  `getTodayPlan?mealPeriod=Lunch` eligible **21 → 22**, `Branko Rubi Steene → bottom`, no longer skipped.
  (First smoke-check hit the pre-propagation @23 for a few seconds; the retest confirmed @24.)
- No sheet edits — the fix is contained to this app, so it doesn't touch the master shared with the
  routes/van projects.

## 2026-06-09 — Lunch pen assignment now reads the master "Jot form Dog Details" sheet (col K), deployed @23

Switched the **lunch Top/Bottom** source from a dedicated B/T tab inside the feeding sheet
(`1Ejjoo55…`, gid `1567330092`, col B) to the shared master **"Jot form Dog Details"** sheet
(`1OD8SQR2WxgO0nncXwBKYAkNv-qAhw018CXaH4kWgTDU`, Master tab gid `0`, **col K** =
`Feeding Pen Top (T) OR Bottom (B)`). Goal: one fewer tab to maintain — pen data now lives beside the
rest of each dog's details (email, parent, van, address) in the single master sheet. `T`/`B`/blank
semantics are unchanged, so this is a source-and-column swap, not a behaviour change. Lunch only;
breakfast/dinner (check-in/out feed), manual board edits, submit, n8n, and the display are untouched.

### Code (`feeding_report_backend_v2.js`, deployed @23)

- **CONFIG:** dropped `BT_PEN_GID`; added `PEN_SHEET_ID` (`1OD8SQR2…`), `PEN_TAB_GID` (`0`),
  `PEN_COL_FALLBACK_INDEX` (`10` = col K).
- **`readPenMap_`** now `SpreadsheetApp.openById(CONFIG.PEN_SHEET_ID)` (we own the sheet, so no sharing
  change needed), finds `PEN_TAB_GID`, and **resolves the pen column by header** (matches `"feeding pen"`),
  falling back to index `10` with a **loud warning** if the header is gone. This is the project-standard
  hardening (global memory #27) against a *shared* master sheet — other workflows edit it (van assignment is
  col J), so an inserted/renamed column must not silently re-key the read. Dog name stays col A;
  `B`→`bottom`, `T`→`top`, blank/unknown → skipped; failures return `{}` + warn (never throw).

### Verification

- **Headless Node harness** against the real source: 16/16 assertions — correct top/bottom, blanks &
  unknown letters skipped, curly-apostrophe name folding, **header-moved still resolved**, **header-renamed
  → fallback to col K + warn**, missing-tab → empty map + warn (no throw).
- **Live new sheet** (gviz CSV) cross-check: 12 cols, `A`=Dog Name, `K`=`Feeding Pen Top (T) OR Bottom (B)`,
  values strictly `B`/`T` (97/189 populated).
- **Live end-to-end** after redeploy `@23`: `getSessionVersion` → `success:true` (compiled);
  `getTodayPlan?mealPeriod=Lunch` → `success:true`, **21 eligible** dogs with correct `penGroup` (e.g.
  April Neve-Jones→bottom, Betty McEwan→top), proving the GAS identity can read the new sheet.

### Follow-up (manual, optional)

- The old B/T tab (gid `1567330092`) in the feeding sheet is now unused and can be deleted to finish the
  consolidation.

## 2026-06-04 — Move leaked secrets out of source (JotForm key + Telegram bot token; no rotation)

JotForm emailed that API key `…cbc7` was publicly exposed in this repo (`Fairytails123/feedingreportmanager`).
Investigation found it inline in the *Submit to JotForm* node URL (live workflow **and** the
`n8n_workflow_v2_corrected.json` mirror), and turned up a **second** committed secret in the same public
repo: the **Telegram bot token** in `feeding_report_backend_v2.js` `CONFIG`. The owner chose to **move both
secrets out of the tracked files without rotating** — so the working tree / HEAD no longer carry them while
the values stay valid. Honest limit (documented, not glossed): moving a key that's already been pushed to a
public repo does **not** un-leak it — both were scraped and remain in git history (commit `b5e6e68`).
Rotation is the only complete fix and was deferred; history was deliberately **not** rewritten.

### JotForm API key → n8n credential

- Created an n8n **`httpQueryAuth`** credential "JotForm API key (eu-api)" (id `XT7arES7w7GdlpOm`),
  domain-restricted to `eu-api.jotform.com`, holding the same key value (no rotation).
- Repointed the live *Submit to JotForm* node (workflow `yaBIrDOVbJTEMsH9`): URL is now just
  `…/submissions` (no `?apiKey=`), `authentication: genericCredentialType` / `genericAuthType: httpQueryAuth`;
  the credential appends `?apiKey=…` at runtime. `n8n_validate_workflow` → 0 errors.
- Scrubbed `n8n_workflow_v2_corrected.json` to the credential reference (kept **tracked** — now secret-free,
  so workflow version history is preserved).

### Telegram bot token → Apps Script Script Properties (`feeding_report_backend_v2.js`, deployed @22)

- Added a `_secret_()` resolver; `CONFIG.TELEGRAM_BOT_TOKEN = _secret_('TELEGRAM_BOT_TOKEN')` (reads the
  `TELEGRAM_BOT_TOKEN` Script Property). Returns `''` if unset, so `sendTelegramSummary` / `testTelegram`
  **fail loud** instead of building a malformed `…/bot/sendMessage` URL.
- Migrated with **no manual GAS-UI step** via a self-seeding two-deploy: v1 (@21) seeded the property from
  the existing literal on first request (verified by a temporary boolean-only `__secretsStatus` action);
  v2 (@22) removed the literal **and** the debug action, so the committed source carries no token.
- `TELEGRAM_CHAT_ID`, `JOTFORM_ID`, `SHEET_ID`, `CHECKINOUT_TOKEN` left inline — group id / public form id /
  sheet id / already-public token; not secrets.

### Docs

- `CLAUDE.md`: rewrote "Secrets currently in source" (new storage + residual-exposure warning + how to
  rotate later) and noted the credential in the "JotForm is in EU Safe mode" bullet. (Also landed earlier
  today from the `/init` pass: a "Commands / quick reference" section and a `doPost` action-list correction.)

### Verified

- Throwaway Node harness against the real backend with Apps Script globals stubbed: v1 (7 assertions —
  seed-on-absent, property-wins-over-legacy, URL carries token) and v2 (10 — token literal absent from
  source, property-read, fail-loud guard blocks the send when unset + no auto-seed, debug action gone).
- Live: GAS @22 `?action=getSessionVersion` compiles; `__secretsStatus` confirmed the property seeded (v1)
  then confirmed its own removal (v2). `git grep` on the pushed commit (`4fc39c4`) finds neither secret in HEAD.
- **Not** exercised live: a real `/send` JotForm submission (would email parents). The change is mechanical
  (same key/param via n8n query-auth) and validates clean; the next genuine `/send` is the final confirmation.

## 2026-06-03 — Drag-to-reorder dogs within a pen (durable, cross-tablet)

Staff could already drag a dog between pens; they asked to also set the **feeding order within** a
pen (e.g. move the 4th dog to the top so it's fed first). Within-pen order is the array order of
`pens[penId]`, which already flowed into the submit/Telegram order — but two things blocked it:
`moveDogToPen` always **appended** (no drop position), and `applyRemoteState` rebuilt each pen from
the server snapshot every ~5s poll, so a local reorder was clobbered within seconds. Made durable and
cross-tablet by persisting a per-dog `Position` in the Session sheet.

### Frontend (`index.html`)

- `computeDropIndex(penEl, draggedId, finalY)` hit-tests sibling `.pen-dog` card midpoints (excluding
  the dragged card, so the index matches the array *after* removal) for the insertion slot;
  `finishDrag` passes it to `moveDogToPen`. Dropping above the first card = move to the top.
- `moveDogToPen(dogId, penId, index)` splices at `index` (append fallback keeps the 2-arg staging
  callers working); `reindexPen()` assigns dense positions (`(i+1)*1000`) and syncs only the dogs
  whose position changed (dragged → `{penId, position}`, shifted → `{position}`). No new queue op —
  `position` rides in the existing `add`/`update` payloads.
- `applyRemoteState` carries `position` through the server / pending-add / pending-update merge layers
  and **sorts each pen by the merged position** (stable; legacy/0 ties keep server-row order). This is
  what stops the ~5s poll from clobbering a reorder; render still draws array order, so the UI can't
  show a half-sorted state.
- Cross-pen drops now land at the drop position (previously always appended). A blue insertion line
  (`.drop-before` / `.pen-dogs.drop-at-end`, inset `box-shadow` so it never reflows the column) shows
  where the drop lands.

### Backend (`feeding_report_backend_v2.js`, deployed via clasp at @20)

- New `SESSION_COLS.POSITION` (col 13 / "M"). `ensureSessionTab` self-heals the header on the existing
  live tab. `getSessionState` returns `position` (legacy rows → 0). `addDogToSession` /
  `updateDogInSession` persist it. `submitReport`'s `getSessionState` *fallback* path orders dogs by
  `[pen, position]` (the normal POST-body path is already ordered by the frontend).
- No data migration: existing rows read `position = 0`, all tie, and the stable sort preserves today's
  order until the first reorder backfills real positions.

### TV display (separate repo `Fairytails123/frmdisplay`)

- `applyData` sorts each pen by `position` (same logic), so the read-only TV mirrors the tablet's
  feeding order within its ~10s adaptive poll. Depends on `getSession` returning `position`.

### Verified

- Throwaway Node harness against the real source — 26 assertions for tablet + backend (column
  read/write/self-heal/fallback-sort; `computeDropIndex`; `moveDogToPen` reindex + sync payloads;
  `applyRemoteState` sort / pending-overlay-wins / legacy-tie stability) and 2 for the display.
- Deploy slip worth noting: a stray temp `.js` left in the clasp clone dir got pushed (duplicate
  `const CONFIG`), 500-ing the web app for ~3 min until the post-deploy `curl` caught it and a clean
  redeploy (@20) fixed it. Lesson recorded in deploy notes — never leave extra files in the clone dir.

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
