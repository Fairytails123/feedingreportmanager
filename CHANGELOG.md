# Changelog

## 2026-08-04 (evening) — TV display: a permanent "Connection error" that was lying

**Reported.** "There is a permanent connection error symbol in the top right corner" of the
feeding TV display — visible in the same photo as the duplicate-names report, while the board was
happily showing 27 dogs.

**Cause — a one-way indicator.** `noteFailure()` set the status pill to `error`, but `noteSuccess()`
only reset the failure counter and the staleness banner; it **never cleared the pill**.
`setRefreshStatus('connected')` lived solely in `loadData()`'s success path — and `loadData()` only
runs when the **version changes**. So a single transient failure lit "Connection error", and on a
quiet board *nothing ever turned it off*, while the 10s version probe kept succeeding behind it.
Today's flaky GAS guaranteed that first failure.

That is worse than having no indicator: staff had no way to distinguish a real outage from a stuck
light, so the one signal telling them whether the board is live had become noise.

**Fix.** `noteSuccess()` now calls `setRefreshStatus('connected')` — a successful poll proves
connectivity, so it must say so. Also removed a stray `noteSuccess(false)` argument that was never
read. Published to `Fairytails123/frmdisplay`; **the TV needs a browser refresh to pick it up.**

**Verified** with a new `tests/display.test.js` (9 scenarios) that assembles the page exactly as
published and drives the connection-health functions, **plus a negative control**: with the fix
stripped out, the indicator provably stays lit after a successful poll. Failures still register and
the two-failure staleness banner still works, so the indicator was fixed, not disabled.

⚠️ **Harness lesson worth keeping:** the first run of this test *failed against correct code*,
because the DOM stub kept `className` and `classList` as separate stores while the real code resets
classes via `dot.className = '...'`. A loosely-modelled stub lies in **both** directions — it hid a
real bug this morning and invented a fake one this evening.

## 2026-08-04 (evening, @34) — TV display showed dogs repeated 3–7 times: `addDog` was not idempotent

**Reported.** "It keeps duplicating the names on the TV display — not in mobile, only the TV."
Photo showed `Leo` ×3 in TOP 1 and `Milo McVey` ×7 in BOTTOM 2, with the red **Connection error**
dot lit. **A separate bug from the morning's outage** — the morning fix did not address it.

**Confirmed live before touching anything:** `getSession` returned **37 rows for 16 unique dogs**,
and the duplicates shared the *same* `Dog_ID` (Bay Ansell ×5, Goose Fowle ×5, Coco Heerema ×4).
Same ID = the same dog written repeatedly, i.e. a **non-idempotent retry**, not bad data entry.

**Cause.** `addDogToSessionCore_` called `sheet.appendRow(row)` unconditionally. The tablet's
durable mutation queue retries an `add` whenever the POST did not *visibly* succeed — and a
client-side fetch abort is indistinguishable from a failure even when the server **landed** the
write. Every retry appended the dog again. The morning's slow/failing GAS is exactly what
generates those aborts, which is why it spiked today (and why the Connection-error dot was lit in
the photo — same root conditions).

**Why only the TV.** Both clients get the same duplicated rows. The tablet's `applyRemoteState`
rebuilds pen membership keyed by dog id, so duplicates collapse invisibly; the display's
`applyData` pushes **every** row into its pen, so it renders each one. The TV wasn't wrong — it
was the only surface telling the truth.

**Fix (@34, v2.4).** `addDogToSessionCore_` is now **idempotent by `Dog_ID`**: it looks for an
existing row and *updates* it instead of appending (already inside the script lock, so the
read-then-write cannot race). A replay refreshes the row rather than duplicating, so a retry
carrying a newer pen/position still wins. The response gains `deduped: true` when a retry lands on
an already-written row. Added `?action=dedupeSession` to repair a tab that already accumulated
duplicates (keeps the last row per `Dog_ID`, deletes bottom-up, safe no-op when clean).

**Verified on the live backend**, not just in tests: posting the same `addDog` twice returned
`deduped:false` then `deduped:true` and left **exactly one row**. Regression tests added
(`tests/backend.test.js` group **M**) covering the retry, the newer-values-win replay, and
`dedupeSession`.

⚠️ **Note on the cleanup:** by the time `dedupeSession` ran, the live tab had already returned to
16/16 on its own (staff were actively rebuilding the board), so it reported `removed: 0`. The
repair path is therefore proven only by test, not by a live repair of real duplicates.

## 2026-08-04 — "Add Dogs for Today" was dead at Lunch: a 12s client abort, and an upstream outage reported as an empty day

**Reported.** "Cannot add today's dogs using add today's dog button — cannot start work", then
"it keeps saying signal is aborted without reason". Staff were blocked mid-morning.

### Part 1 (hotfix, shipped first) — the tablet was timing ITSELF out

`gasFetch` applied one flat `FETCH_TIMEOUT_MS` (12s) to **every** GAS call, including
`getTodayPlan` — the one endpoint that is legitimately slow, because it fans out to the
Whiteboard web app and, at Lunch, also opens the shared master pen sheet. "signal is aborted
without reason" is Chrome/Android's `AbortError` message: the tablet's own AbortController, not
a network fault. Measured live: **Lunch 10.9s / 15.7s / 3.8s** (breakfast 1.9–2.9s, dinner
2.0–4.6s), so the Lunch path straddled the abort exactly when the board gets set up.

- `gasFetch(url, opts, timeoutMs)` — optional third arg; omit it and every pre-existing caller
  keeps 12s (asserted by test).
- `addDogsForToday` uses `PLAN_FETCH_TIMEOUT_MS` (45s) + one retry, and reports a timeout in
  words instead of leaking the raw `AbortError`.

### Part 2 — the bigger bug the measurements uncovered: an outage looked like a quiet day

Probing the upstream `?action=loadToday` directly: **HTTP 404 + a 3,039-byte Google "Page not
found" page for ~40% of requests, taking 8–43s to fail** (5/12 at a realistic 30s cadence;
6/10 back-to-back). Successes ranged 1.7–24s. `fetchJson_` returned `null` for that, and
`getLunchPlan_` turned `null` into `roster = []` → `{success: true, dogs: []}`. The tablet then
showed **"No Lunch dogs found on the whiteboard for today"** as an `info` toast —
indistinguishable from a genuinely empty day, so staff hand-built the board during an outage.
`readPenMap_` had the same shape and was worse: the roster read *succeeds*, so every count looks
plausible while an unreadable pen sheet drops every dog through the "Lunch Y?" gate.

⚠️ **The Part 1 retry could never fire on this path** — the loop breaks on `result.success`, and
the backend was returning `success: true`. Part 1 fixed the reported abort; Part 2 fixes the 404.

**Backend (`feeding_report_backend_v2.js`, @30):**
- `fetchJson_(url, opts)` gains a real error channel (`opts.out.ok/error`) — `null` used to mean
  *both* "failed" and "empty". Everything else is downstream of that one conflation.
- `getLunchPlan_` / `getBoardingPlan_` return `success:false` on a failed read (and on a 200
  carrying `success:false`, e.g. a rejected `CHECKINOUT_TOKEN`). Safe: `addDogsForToday` is the
  sole consumer and already renders `success:false`.
- `readPenMap_` reports `ok/error` so an unreadable pen sheet is an outage, not a quiet day.
  **A sheet with zero "Lunch Y?" rows is deliberately NOT a failure** — that is a legitimate
  state, it would black out the button all day with no override, and the tablet already reports
  it better (it names the roster count and the column to check).
- Script-cache layer, best-effort by design (a cache outage degrades to a live read):
  **FRESH 120s** so most presses skip the flaky upstream entirely, and **last-known-good 2700s**
  (45 min, *not* the 6h cap — a six-hour-old lunch roster is a different day's service, and the
  tablet merges without removing, so it could put a departed dog into a live feeding round).
  Keys carry `(v1, today, mealPeriod)`, so an LKG can never cross midnight or meals. An **empty**
  LKG is refused — serving it would fire the stale warning *and* "no dogs found" together.
- `?fresh=1` bypasses the cache; the tablet sends it on any repeat press.
- `doGet` now returns `success:false` for an **unrecognised action** (a bare `/exec` ping stays
  `success:true` — it is the documented smoke check). Previously a frontend deployed ahead of the
  backend read as a quiet day rather than a version mismatch.
- No retry against the whiteboard (`attempts: 1`): its failures take 16–43s so a retry could never
  clear the deadline gate, and the producer documents that this `/exec` degrades under concurrent
  load. Retry stays armed only on the fast, healthy check-in/out feed.

**Tablet (`index.html`):** one `info` toast covering six distinct causes became accurate,
cause-specific messages; `skipped` names are surfaced (previously swallowed by the empty-guard
exactly when they mattered); the stale warning goes in the **`confirm()` text**, not a toast —
`confirm()` blocks, so a toast may never paint before the modal.

**⚠️ Deploy order is load-bearing: `index.html` via Pages FIRST, then `clasp redeploy`.** The old
page has no `stale` branch, so a backend-first deploy hands staff an unmarked 45-minute-old roster.
Frontend-first is safe both ways (it tolerates a backend that omits the new fields).

**Deliberately NOT done** (with reasons, so they are not re-proposed): caching `readPenMap_` — it
is ~2s of a ~4s best case and its `firstLast` map, built over every named row of the shared master
sheet at ~110–145 bytes/row, sits within 2× of CacheService's hard 100KB per-value cap, which
*throws* rather than degrading; and a pre-warm trigger — the 90 min/day trigger budget is **per
Google account** and shared with the Whiteboard project's own 14:05 pull, and a 5-minute pre-warm
costs 66–96 min/day on the measured failure mix (the @29 failure shape: fine all morning, dead
mid-afternoon, looks like something else).

### Part 3 (@32) — root cause removed: the lunch roster is read straight from the Staff Board sheet

The 404s were never this app's to fix: they come from the Whiteboard project's `/exec`, which is
shared with its TV display (97s poll), its mobile editor (93s poll + autosave) and the Routes feed,
and which that project had already logged at ~01:00 the same day as degrading under concurrent load.
But the **data** behind that endpoint is a Google Sheet owned by the same account as this script — so
we can read it directly and skip the failing hop entirely.

`readStaffBoardToday_()` opens `CONFIG.STAFF_BOARD_SHEET_ID` (`1kQsNXee…`, tab `Today`) and resolves
`Dog_Name` + `Appointment_Type` **by header name**. No new OAuth scope (this script already
`openById`s the master pen sheet). The web app remains the **fallback**.

Design rules, each deliberate:
- **Strictly read-only.** It mirrors the producer's `loadBoardData` for the two fields consumed (row
  counts when either `ID` or `Dog_Name` is non-empty; missing cells coerce to `''`) but deliberately
  does NOT mirror its `getOrCreateSheet` — creating a tab would make this app a *writer* in another
  project's workbook. A missing tab is reported, never repaired.
- **Never guesses a column by position.** If the headers can't be resolved it returns not-ok and falls
  back to the web app, which runs the producer's own reader including its own positional fallback —
  so that heuristic keeps exactly one implementation, theirs.
- **`rosterSource: 'sheet'|'webapp'`** is on the response so a silent degradation back to the flaky
  path is visible from outside instead of hiding behind a working button.

**Result, measured live:** 10/10 lunch reads via the sheet, **zero failures**, 2.7–7.9s (cached 1.0s)
— against 2–48s with ~40% failures through the web app. Dog counts unchanged (19 lunch / 18 breakfast
/ 19 dinner). Breakfast and dinner are untouched: they use the check-in/out feed, which was always
healthy (it serves from a 5h cache with a 6h stale fallback — the pattern this app now mirrors).

⚠️ **New cross-project coupling.** This app is now a consumer of the Staff Board **sheet schema**, not
just the web-app JSON. Renaming the `Dog_Name` or `Appointment_Type` headers in the `Today` tab drops
this app back to the flaky web app (it fails safe, not silently wrong — `rosterFallbackReason` records
why). The producer's own docs list the enforcement sites for that schema and should be updated to
include this one.

**The upstream endpoint is still broken for everyone else.** The 404s come from the Whiteboard staff-board
`/exec`, which the producer already logged at ~01:00 the same day as degrading under concurrent
load (its TV display polls every 97s, the mobile editor every 93s plus autosave, and the Routes
feed on every stage press). The durable cure is either a response cache there — its healthy
sibling, the check-in/out feed, already serves from a 5h cache with a 6h stale fallback, which is
exactly why that endpoint never failed in probing — or having this app read the Staff Board sheet
(`1kQsNXee…`, tab `Today`, `Dog_Name` + `Appointment_Type`) directly and skip the web-app hop.

**Verified** with headless harnesses against the real source before deploy: backend 64/64 (Apps
Script globals + `CacheService`/`Utilities.sleep` stubbed), tablet 35/35 — including a negative
control proving the pre-fix code reproduces the exact "signal is aborted without reason" staff saw.

### Part 4 — the harness became a committed suite: `bash tests/run.sh`

The verification harness had been **rebuilt from scratch every session and thrown away** since
2026-06-02, which is why nothing caught this outage earlier. It now lives in **`tests/`**
(`tablet_harness.js`, `backend_harness.js`, `tablet.test.js`, `backend.test.js`, `run.sh`) and
chains syntax → contract drift → backend (64) → tablet (35). `tests/README.md` records **why each
group exists**, so a future session can't delete a scenario without seeing which outage it
protects against. The same was done for the staff board, which had **no test step at all**:
`Whiteboard and Routes\Whiteboard Mobile Edit\tests\` (47 tests, incl. the `flush()`-before-bump
write-visibility assertion).

Two limits are written into both READMEs so they aren't rediscovered the hard way: a stubbed Apps
Script has **no write-visibility semantics** (a 30/30-green suite shipped a silent data-loss bug),
and it has **no concurrency and no n8n** — so the riskiest paths still need a live exercise after
deploy, per the project's own live-edit rule.

## 2026-07-26 — TV display consolidated into this repo (phase 2): hardened display v2 + shared contract + one-command publish

**What.** The TV Feeding Display's source moved from the un-tracked OneDrive file
(`..\Feeding report display\Feedingreport_display.html`, now renamed `.RETIRED-2026-07-26.bak` with a
redirect-stub CLAUDE.md) into this repo as `display/display.html`, rebuilt on the tablet's hardened
connection patterns. New `shared/contract.js` single-sources the exec URL, pen IDs, status value set,
fetch timeout, the AbortController-wrapped `frmMakeGasFetch` (with old-TV-browser fallbacks: no
AbortController → plain fetch; no `.finally`/`globalThis` used), and the per-pen `Position` sort. The
tablet stays **byte-identical** (its inline copies are asserted by the new `scripts/check_contract.js`
tripwire, which also checks the backend's penOrder/penRank and status map).

**Display v2 behaviour changes** (all connection-facing; rendering/CSS/branding preserved):
- 12s fetch abort (a hung request no longer dangles for minutes) + in-flight guards (overlapping
  fast-mode loads can no longer apply out of order).
- **TV-readable staleness banner**: "CONNECTION LOST / NOT LIVE — showing data from HH:MM" after 2
  consecutive failures or >60s without a confirmed-current board; the stale pen grid stays visible
  behind it. A change-detected probe deliberately does NOT count as confirmation — only the successful
  full load does (prevents banner flap under partial outage).
- A `success:false` version check is counted as a failure (was silently swallowed, dot stayed green);
  a failed FIRST load drops to the board + banner instead of an infinite loading overlay; outages no
  longer trigger the old "full reload every 10s" fallback (the display used to poll HARDER while down).
- Change gating: `lastKnownVersion/Count` advance only after a successful full load, so a failed load
  is re-detected on the next 10s probe instead of lost. Works because backend @29 serves the identical
  Meta version from both endpoints.

**Deploy pipeline** (replaces the manual 4-step clone-overwrite-push dance from an un-tracked file):
`bash scripts/publish_display.sh "msg"` = contract drift-check → `scripts/assemble_display.js` (injects
the contract at the `// @@CONTRACT@@` marker, LF-normalised, sanity-asserts the artifact) → clone
`Fairytails123/frmdisplay` → commit + push. `--dry-run` stops before the clone. The TV's URL is
unchanged (https://fairytails123.github.io/frmdisplay/); **the TV picks the new page up on its next
browser refresh/restart**, so publishing is never an instant change to the live screen.

**Verification.** 30-assertion headless harness driving the ACTUAL assembled page against the ACTUAL
v2.1 backend (boot, idle stability, change-render-once, failed-load re-detection, in-flight guard,
offline banner show/clear, silent-staleness banner, first-load failure recovery, swallowed-error fix,
position sort) — 30/30. Independent adversarial review of the assembled artifact (traced every DOM id,
timer state machine, change gate, browser-compat inventory): OK_TO_PUBLISH, 1 minor (banner flap —
fixed pre-publish) + nits (dead `lastRenderAt` removed, "(1 min ago)" overstatement → "moments ago").
Published to frmdisplay `9b42d7c`; served page verified via cache-busted fetch.

## 2026-07-26 — Backend v2.1 (@29): lazy token read, Meta-tab real versions, write locks (phase 1 of the tablet+TV consolidation)

**Why.** An audit of "connection issues / sync delays" (prep for merging this app with the TV Feeding
Display) found three backend defects: (1) the bot-token Script-Properties read ran at **global scope**,
costing 1 read per request against the **50,000/day quota** — an always-on fleet (~30k/day per tablet +
~26k/day TV) could exhaust it mid-day, failing **every** endpoint at once (the whole fleet "loses
connection" simultaneously); (2) `getSession` returned `version: Date.now()` (always fresh) while
`getSessionVersion` returned max `Last_Updated` — the TV display stores the former and compares against
the latter, which can **never match**, locking the TV in a permanent ~40s fast-mode loop (~26k full-sheet
reads/day instead of the designed ~8.6k, even overnight on an empty board); (3) no write serialization —
concurrent edits from two tablets could shift an update/meal-type write onto the **wrong dog's row**.

**Fix (all in `feeding_report_backend_v2.js`, deployed @29 on the same `/exec` URL):**
- **Lazy token**: `_secret_('TELEGRAM_BOT_TOKEN')` is called only inside `sendTelegramSummary`/`testTelegram`
  (~1 Properties read per submit, was 1 per request). Never reintroduce a global-scope read.
- **Real versions**: new hidden GAS-owned **Meta** tab (`A2` version, `B2` count). Every mutation bumps
  `max(now, stored+1)` inside its lock — **including deletes and clears**. Both read endpoints return the
  identical Meta version, with aligned non-empty-`Dog_ID` counts. Out-of-band count changes (n8n `/cancel`
  whole-tab wipe, manual row edits) self-heal on the next read (count drift → bump → all clients refetch).
  **Response contract:** `addDog/updateDog/deleteDog/setMealType` responses carry **no `version`** (the
  tablet's guarded `flushQueue` must not advance `lastSyncVersion` past never-applied remote edits — this
  also fixes a reconnect edge where another device's offline-window edits were skipped); `clearSession`
  **keeps** `version` (tablet assigns it unguarded).
- **Write locks**: `withScriptLock_` around all five session mutators + `submitReport`'s Temp rebuild +
  `clearTempTab`/`repairTemp`. `deleteDog` waits **20s** (> the tablet's 12s abort) so lock contention
  becomes a client-side retry, never a rejection the tablet would dequeue as "already gone" (dog
  resurrection). Telegram send stays **outside** the lock. Bumps after landed writes are best-effort
  (`tryBumpSessionVersion_`) so a Meta hiccup can't turn into a duplicate-append retry. `submitReport`
  retries a failed post-Telegram clear once and reports `sessionCleared` (additive field).

**Effect on the fleet (no client was changed — tablet + TV are byte-identical):** the tablet's
`version > lastSyncVersion` poll gate became genuinely change-gated (applyRemoteState only on real
changes); the TV's adaptive refresh stabilised (idle = one cheap version check per 10s, full reload only
on change — ~65% fewer TV requests); the mid-day whole-fleet quota outage mode is gone.

**Verification.** 54-assertion headless Node harness against the real backend source AND the real TV
display script (endpoints agree, per-mutation bumps, response contract, wipe self-heal, lock contention,
offline-reconnect merge, display stabilisation, review-fix hardening) — 54/54. Two-agent adversarial
review of the diff (0 blockers; 4 minors found and fixed pre-deploy). Live smoke @29: ping shows v2.1,
add→update→delete cycle bumps and agrees across both endpoints at every step, repeated idle reads stable,
`clearSession` returns numeric version, stale staged Temp row untouched. One stale old-code response was
observed during the ~1-min redeploy overlap (expected, converges).

**Follow-ups:** phase 2 = contract-only merge of the TV display into this repo (hardened fetch + staleness
banner on the TV, single-sourced constants, scripted publish to the existing `frmdisplay` Pages URL).

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
