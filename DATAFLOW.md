# Feeding Manager — System Data Flow & Architecture

A plain-English, engineer-grade map of how the whole system works: the logic, the
sequence, and **where data flows from and to**. Grounded in the actual source
(`index.html`, `feeding_report_backend_v2.js`, `n8n_workflow_v2_corrected.json`).

> Companion docs: `CLAUDE.md` (instructions written for the AI assistant) and
> `CHANGELOG.md` (history). This file is the human-facing architecture overview.

---

## 1. What it does, in one sentence

Staff log a feeding session on a **tablet** → the data is staged in a **Google Sheet**
→ Apps Script posts a **review summary to a Telegram group** → a human replies **`/send`**
→ **n8n** pushes each dog's record into **JotForm** → JotForm **emails the parents**.

## 2. The one idea that explains everything

**Nothing talks device-to-device.** The tablet, the TV display, and the n8n automation
never connect to each other. They are all independent **clients of a single Google Apps
Script (GAS) web app**, and GAS is the *only* thing that reads or writes the **Google
Sheet**. The Sheet is a shared whiteboard — the entire "nervous system" of the app.

So when staff report "it lost connection," it means **GAS calls are failing
intermittently**, not that a live socket dropped.

## 3. The components (and where each lives)

| Part | What it is | Where it lives |
|------|-----------|----------------|
| **Tablet UI** | `index.html` — one self-contained HTML file (inline CSS + JS, no framework) | GitHub Pages (this repo) |
| **GAS backend** | `feeding_report_backend_v2.js` — a `/exec` web app | Apps Script project "Feeding manager" (this file is a mirror) |
| **Google Sheet** | 4 tabs: Lookup / Session / Temp / Meta (hidden, GAS-owned: real session version + count, added 2026-07-26) | `1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc` — the **shared state bus** |
| **Telegram group** | review + command channel | chat `-1003653235960`, bot "Feeding report bot" (id 8436854999) |
| **n8n workflow** | handles `/send` `/cancel` `/status` | self-hosted VPS `auto.thefairytails.co.uk`, workflow `yaBIrDOVbJTEMsH9` (this JSON is a mirror) |
| **JotForm** | per-dog form that emails parents | form `240143730611039`, EU instance |
| **TV display (pens)** | read-only board mirror **+ medication-signal consumer** (own plan fetch) | source **in this repo** (`display/display.html` + `shared/contract.js`, since 2026-07-26); published via `scripts/publish_display.sh` to the Pages repo `Fairytails123/frmdisplay` (the TV's URL) |
| **White Board project** | roster source for "Add Dogs for Today" | a *separate* GAS app + sheet `1kQsNXee…` |

## 4. The map

⚠️ **Since @36 (2026-08-05) the LIVE BOARD IS NOT IN THE SHEET.** It lives in n8n on the VPS.
Apps Script keeps only the three infrequent endpoints. Read §4a before trusting any older
description of "the Session tab is the live state".

```
   THE HOT PATH  (~95% of all traffic: 4 devices, every 5s)
┌──────────┐   ┌─────────────┐
│ Tablet UI│   │  PENS TV    │      getSessionVersion / getSession
│index.html│   │  frmdisplay │      addDog / updateDog / deleteDog
└────┬──┬──┘   └──┬───────┬──┘      setMealType / clearSession
 staff EDIT   read-only   │
     │  │         │       │
     │  └────┐    │       └────┐   ...and BOTH also read the BOARDING PLAN
     │       │    │            │   feed for medication (see 4c):
     │       ▼    │            ▼   GAS /exec?mode=feeding  (45s budget,
     │   ┌────────┴──────────────┐  NOT the 12s session budget)
     │   │ boarding Apps Script  │
     │   └───────────────────────┘
     └────────┬───────┘   POST JSON   ~0.70s mean, 1.83s worst, 0 failures
              ▼
   ┌──────────────────────────────────────────┐
   │  n8n VPS  /webhook/feeding-session        │
   │  workflow hdGUbrd0PffVnwDS                │
   │  Data Tables: feeding_session + _meta     │  ← THE AUTHORITATIVE BOARD
   └───────────────────┬──────────────────────┘
                       │ after responding: ONE atomic range write A2:M201
                       ▼
   ┌──────────────────────────────────────────────────────┐
   │        GOOGLE SHEET                                    │
   │  Lookup │ Session (MIRROR only) │ Temp │ Meta (legacy) │
   └──────────────────────────────────────────────────────┘
                       ▲
   THE COLD PATH       │  submitReport (a few/day) · getTodayPlan · getDogList
   ┌───────────────────┴──────────────────────┐
   │   GAS Web App   (single /exec URL)        │  median 4.5-8.7s, 55.6s peak, flaky
   │   doGet(?action=) / doPost(data.action)   │
   └──┬───────────────────────────┬────────────┘
      │ posts review summary       │ server-side reads (White Board project:
      ▼                            ▼  check-in/out + Staff Board sheet)
┌──────────┐                ┌──────────────────┐
│ Telegram │                │  White Board app │
│  group   │                └──────────────────┘
└────┬─────┘
     │ human reads + replies /send
     ▼
┌──────────┐  reads Temp tab   ┌──────────┐
│   n8n    │─────────────────▶ │ JotForm  │─▶ emails parents
│ yaBIrD…  │  POST submission  │ (eu-api) │
└──────────┘                   └──────────┘
```

**Reading it:** the tablet and TVs talk to **n8n** for everything about the live board, and to
**GAS** for submit, the whiteboard roster, the dog-name lookup — and, since 2026-08-25, the
**boarding-plan medication feed**, which the tablet, the plans TV and the **pens TV** each fetch
independently (`FRM_CONTRACT.BOARDING_PLANS_URL`, `?mode=feeding&token=…`). The pens TV was a
single-feed n8n reader until then, which is exactly why a plan-declared medication dog showed no
red on the one screen staff read at the kennel. See §4c. `submitReport` clears the
n8n board as well as the sheet (`liveBoardCleared`), because the TV reads n8n. Every handler on
both sides returns `{success, …}` — neither throws back to the client.

## 4a. Why the session left Apps Script (read before "improving" this)

Measured live 2026-08-05, same test both sides:

| | Apps Script `/exec` | n8n on the VPS |
|---|---|---|
| median / mean | 4.5–8.7s | **0.70s** |
| worst | **55.6s** | **1.83s** |
| failures | ~40% past the tablet's 12s abort, plus Google 404s | **0 / ~40 calls** |

The decisive experiment: a bare `/exec` ping doing **no spreadsheet work at all** was just as slow
(55.6s worst). So the bottleneck was **Apps Script's dispatch layer** — not the data, not the code.
The originally-planned fix (cache `getSessionVersion` so it never opens the spreadsheet) would have
achieved **nothing**. Apps Script allows ~30 simultaneous executions **per Google account**, shared
with Staff Board, Training Planner, Boarding API, Grooming and Order list.

Against a 12s client abort, a ~40% slow rate is exactly what staff experienced as "connection
lost" — the tablet was aborting **itself**.

## 5. The three Sheet tabs (the state bus)

| Tab | gid | Role |
|-----|-----|------|
| **Lookup** | `0` | Permanent. `Dog Name \| Parent Email \| Parent Name`. Source of truth for emails. |
| **Session** | `1038940935` | ⚠️ **MIRROR ONLY since @36** — n8n writes it as one atomic `A2:M201` block after answering the client. Same 13 columns. It exists for human readability, the `/status` command and `submitReport`'s legacy fallback. **The live board is the n8n `feeding_session` Data Table.** Never point a new reader here and never write to it. |
| **Temp** | `1965265218` | Submission staging (7 columns) that n8n reads on `/send`. Row 1 is a load-bearing header. |

(Lunch pen side is **no longer** in this sheet — as of 2026-06-09 it comes from the **external** master "Jot form Dog Details" sheet `1OD8SQR2…`, col K; see Phase 2. The old B/T pen tab `1567330092` here is retired/deleted.)

---

## 6. The sequence, phase by phase

### Phase 0 — Boot (tablet load)
`initialLoad()` runs, in order:
1. `loadQueue()` — restore the **durable edit queue** from localStorage (`feedingManager.queue.v1`), so unsynced edits survive a refresh.
2. **GET `?action=getDogList`** → **GAS** reads **Lookup** → names + parent emails.
3. **POST `{action:'getSession'}`** → **n8n** → `applyRemoteState()` paints the board.
4. `flushQueue()` — push up anything queued while offline (POSTs to **n8n**).
5. Start the **single 5-second version-first poll** (`pollForUpdates`) — see Phase 1. The old
   separate 7-second heartbeat was removed in @35; the poll absorbed its job.

### Phase 1 — Every local edit (add dog, set amount, medicine, drag, change meal)
Edits do **not** POST directly. They go through a durable queue:

```
edit → syncAddDog/UpdateDog/DeleteDog/MealType → enqueue {op, dogId, payload}
     → save queue to localStorage → flushQueue() → POST to n8n → n8n writes the Data Table
                                                              → (after responding) mirrors to Sheet
```

The **op shapes did not change** in the n8n move — `{action:'addDog', dog}`,
`{action:'updateDog', dogId, updates}`, `{action:'deleteDog', dogId}`,
`{action:'setMealType', mealType}` — so the durable queue survived that move untouched. It was
hardened later, on 2026-08-05 (@37), for the in-flight race below.

- The **queue owns ordering and retry**, not the call site. It drains in order, removes an
  item only after its POST succeeds, **stops on the first failure** and retries next cycle,
  and **drops an item after 5 rejections** so one bad edit can't jam the whole queue.
- ⚠️ **An edit made WHILE a POST is in flight must not be merged into it** (`it.inFlight`), and a
  finished item is removed **by identity, never by `shift()`**. `flushQueue` serialises a payload
  the moment it POSTs it and discards the item on success, so merging into that object writes
  fields into something already on the wire and about to be thrown away. Found live: on the
  redesigned tile, portion + medicine + supplements are one panel, so tapping ½ → Medicine →
  typing "Metacam" fired three edits inside one ~700ms round-trip and **only the ½ landed**, with
  no error anywhere. Two siblings: a `delete` for a dog whose `add` was in flight orphaned the row
  server-side, and a queue rebuilt mid-flight made `shift()` discard a *different* dog's edit.
  Regression tests: `tests/tablet.test.js` **S22**.
- The **5s poll** is **version-first**: every tick costs one cheap `getSessionVersion` and the
  full `getSession` runs only when the version actually moved. It keeps running while **editing**
  and while **offline** (only the board *write* is gated on the edit pause, and since @37 also on
  `isDragActive()` — re-rendering a pen while a dog is in the air replaces the captured tile and
  the browser fires `pointercancel`, dropping the dog somewhere nobody asked for) — that is what
  the deleted 7s heartbeat used to provide, and `tests/tablet.test.js` S13/S14 exist to stop
  anyone re-gating it. When it does fetch, `applyRemoteState()` **merges** the server
  snapshot with your pending queue. The rule: **the server wins only for dogs you have no
  pending change on** — pending adds are kept, edits re-applied, deletes suppressed. Then it
  **sorts each pen by the `Position` column**. This merge is exactly why a ~5s poll never
  wipes an edit you just made, and why a second tablet / the TV sees your change in seconds.
- **Connection state:** all calls go through `gasFetch()` (12s timeout). `isOnline` flips
  false only after **2 consecutive failures** (debounces wifi blips). **Submit is enabled
  only when `isOnline && queue is empty`** — i.e. only when the screen truly matches the server.

### Phase 2 — "Add Dogs for Today" (cross-project read)
`addDogsForToday()` picks the meal from the tablet clock (`<10:00` Morning, `<14:00` Lunch,
else Evening), then **GET `?action=getTodayPlan`**. GAS (computing "today" in `Europe/London`)
reads your **separate White Board project**:
- **Morning/Evening** → the check-in/out feed (who's boarding tonight / slept here last night).
- **Lunch** → the Staff Board **`Today` tab read DIRECTLY** (`1kQsNXee…`, columns resolved by header name `Dog_Name` / `Appointment_Type` — `readStaffBoardToday_`, since @32 on 2026-08-04) + the master **"Jot form Dog Details"** sheet (`1OD8SQR2…`), joined by dog name (exact `normName_` with an ambiguity-guarded first+last-token fallback that also bridges dog-first-name|owner-surname, e.g. roster `Oliver / Ollie Reed` ↔ master `Oliver`). A dog (day-care **or** boarding) is added to a lunch pen **only if** the master flags **"Lunch Y?"** (col L) = `Y` **and** gives a `B`/`T` pen (col K) — the staff opt-in for the lunch board, *not* the report (sent later on submit). No `Y` → not added; `Y` + no pen → `skipped`. (Universal Lunch-Y gate since 2026-06-19 / @26; was day-care-pen-only + boarding-opt-in before.)

It returns the dogs; the tablet skips any already on the board and drops each new dog into
the **least-occupied eligible pen** (`pickLeastOccupiedPen`).

**⚠️ Failure semantics (2026-08-04 — this is the day-long outage, don't regress it).** The old
`?action=loadToday` web app returned HTTP 404 for ~40% of requests, and a failed read used to
become an empty roster with `success:true` — so staff were told *"No Lunch dogs found on the
whiteboard for today"* during an outage. Now: **a failed read is `success:false`, never an empty
day**; a genuinely empty roster is still `success:true` with 0 dogs. The Lunch path reads the
sheet directly and falls back to the web app only if the headers can't be resolved or the
workbook can't be opened (`rosterSource:'sheet'|'webapp'` says which was used). A short **plan
cache** serves repeat presses, and a **last-known-good** copy (45 min, same-day + same-meal only,
never empty) is served during an outage marked `stale:true` + `capturedAt` — which the tablet
shows in the **`confirm()` dialog**, not a toast. `?fresh=1` bypasses the cache; the tablet sends
it on any repeat press. The tablet gives this one call a 45s budget (`PLAN_FETCH_TIMEOUT_MS`)
because every other call keeps the standard 12s.

### Phase 3 — Submit (the critical safety handshake)
`confirmSubmit()` first **guards**: if offline or the queue isn't empty, it blocks and warns.
Otherwise it **POSTs `submitReport` with the dogs from the tablet's own memory** (not the
Sheet — your latest edits may not have synced yet). Then GAS `submitReport()`:

```
GAS submitReport():
  1. Trust dogs[] from the POST body (fall back to Session only if body is empty)
  2. Load Lookup → parent emails
  3. Rebuild/repair the Temp header, clear old Temp rows
  4. Write Temp tab — one row per dog
  5. Build a prefilled JotForm review link per dog
  6. sendTelegramSummary()  ← grouped by pen, with review links
        │
   Telegram delivered?
   ├─ NO  → return {success:false, telegramSent:false}   (Temp + Session KEPT — safe retry)
   └─ YES → clearSession() → return {success:true, telegramSent:true}
```

The tablet counts it done only if **both** `success` **and** `telegramSent` are true; on any
failure it **keeps the board and the queue** for a safe retry. **The board is wiped only
after Telegram has confirmed the review message went out** — that is the key data-safety rule.

### Phase 4 — A human reviews on Telegram
The group sees the summary with a review link per dog. Someone replies **`/send`** (approve),
**`/cancel`** (discard), or **`/status`** (what's pending). The Temp tab sits there durably
until they do — nothing is lost between posting the links and the human replying.

### Phase 5 — `/send` → n8n → JotForm → parents emailed
n8n's `Telegram Trigger` catches the message; `Command Router` (matching with `startsWith`,
so `/send@BotName` works in the group) branches:

- **`/send`** → `Read Temp Tab` → `Has Data?` → `Prepare JotForm Data` (builds the
  `submission[<qid>]=…` body) → `Submit to JotForm` (one POST per dog to **`eu-api.jotform.com`**)
  → `Count Results` → `Clear Temp Tab` (clears rows **but keeps the header**) → `Send Success Message`.
  **JotForm then emails the parents automatically.**
- empty Temp → "No reports to submit."
- **`/cancel`** → clears Temp + Session → "Cancelled."
- **`/status`** → counts pending rows in both tabs → reports back.

> **Two-stage JotForm:** the links GAS posts to Telegram are *prefilled previews* for the
> human. The **real submissions** that email parents are the ones n8n POSTs from the Temp
> tab on `/send`. The Temp tab is the bridge: GAS writes it, n8n reads + clears it.

**JotForm question-ID map:** `3` date · `6` food · `7` supplements · `9` meal ·
`10` has-medicine · `13` name · `14` email · `21` comments.

---

## 7. GAS endpoint quick reference

Since 2026-07-26 (@29): `version` is the **real monotonic Meta-tab version** (identical from both read
endpoints; bumped by every mutation inside its script lock — deletes and clears included). Write
responses deliberately carry **no `version`** except `clearSession` (the tablet assigns that one
unguarded). All mutators are serialized under `LockService` (see CLAUDE.md "Session versioning is
REAL now" for the full contract — preserve it).

### 7a. n8n — `POST https://auto.thefairytails.co.uk/webhook/feeding-session` (the live board)

Workflow `hdGUbrd0PffVnwDS`. Data Tables `feeding_session` (`nnbHmglWVbneFigg`) +
`feeding_meta` (`5TGDqjRVlrczGUgm`). All calls are `POST {action, …}` JSON.
**Every row here is asserted by `tests/live_api.test.js` — run `LIVE=1 bash tests/run.sh` after
any workflow edit.**

| Action | Reads | Writes | Returns |
|--------|-------|--------|---------|
| `getSessionVersion` | `feeding_meta` | — | `{success, version, count, mealType, source:'n8n'}` |
| `getSession` | `feeding_meta` + `feeding_session` | — | `{success, dogs:[…], mealType, version, count}` — **same `version` as above; one source** |
| `addDog` | session (match `dog_id`) | **upsert** + meta bump + mirror | `{success, count, mealType}` — **no version**. Idempotent by `dog_id` |
| `updateDog` | session | **partial** update (only changed columns) + meta bump + mirror | `{success, count}` — **no version** |
| `deleteDog` | session | delete row + meta bump + mirror | `{success, count, dogId}` — **no version**; deleting an absent dog still succeeds |
| `setMealType` | meta | meta bump + mirror | `{success, mealType}` — **no version** |
| `clearSession` | session | delete all rows + meta bump + mirror | `{success, version, count:0}` — the ONE write that keeps `version` |
| *(unknown)* | — | — | `{success:false, code:'UNKNOWN_ACTION', retryable:false}` |

### 7b. Apps Script — `/exec` (what is LEFT on GAS)

| Action | Method | Reads | Writes | Returns |
|--------|--------|-------|--------|---------|
| `getDogList` | GET/POST | Lookup | — | `{success, dogs:[{name,email,parentName}]}` |
| `getTodayPlan` | GET/POST | Staff Board `Today` tab **direct** (web app = fallback) + check-in/out feed + master pen sheet (col K) | — | `{success, mealPeriod, today, dogs, skipped, counts, rosterSource}` — **`success:false` on a failed read, never an empty day**; `+ stale, capturedAt, upstreamError` when a last-known-good copy is served; `+ cached` on a cache hit. `?fresh=1` bypasses the cache |
| `submitReport` | POST | POST body / Lookup / Temp | Temp (locked) → Telegram → clears **n8n board** + Session mirror | `{success, telegramSent, sessionCleared, liveBoardCleared, dogsProcessed}` |
| `repairTemp` | GET | Temp | Temp (rebuild header, locked) | `{success, dogRows}` |

**Still present on GAS but no longer on the hot path** (legacy/recovery only — the clients do not
call them): `getSession`, `getSessionVersion`, `addDog`, `updateDog`, `deleteDog`, `setMealType`,
`clearSession`, `dedupeSession`. They still read/write the Session **mirror**, so using them will
put the sheet out of step with the real board until n8n's next write. Don't.

## 8. Why it's built this way (the decisions that matter)

- **Durable edit queue** → wifi can die mid-session with zero data loss; edits replay on reconnect.
- **Real change-gated versioning (Meta tab, 2026-07-26)** → clients fetch full state only when something actually changed; the TV's adaptive refresh stopped oscillating (~26k → ~9k requests/day) and the tablet stopped re-applying state every 5s.
- **Secrets are read lazily, never at global scope** → GAS re-evaluates globals per request, and a global Script-Properties read burned 1 of a 50k/day quota per poll — enough to fail the whole fleet mid-day.
- **Writes are lock-serialized** → concurrent edits from two tablets can no longer land on the wrong dog's row.
- **Submit trusts the tablet's memory, not the Sheet** → your latest taps count even if they haven't synced.
- **Wipe only after Telegram confirms** → a failed notification never destroys a report.
- **n8n addresses Sheet tabs by numeric `gid`, not name** → using the name throws `Sheet with ID Temp not found`; this silently broke `/send` for months.
- **The Temp header is load-bearing and self-healing** → n8n keys columns by the row-1 header; a blank header makes every report read as empty, so GAS rebuilds it and n8n clears around it (`specificRange`, not whole-sheet).
- **EU JotForm endpoint** → plain `api.jotform.com` 301-redirects and drops the POST body.
- **iOS-safe URL encoding** → links are built with `+` (no `%XX`) because iOS Telegram double-encodes percent sequences and breaks the target app.
- **Defensive JSON parsing** → one corrupt Session cell can't break `getSession` for every device.

## 9. Failure modes the design survives

| Failure | What happens |
|---------|--------------|
| Wifi drops mid-edit | Edits queue locally, replay on reconnect; Submit disabled until synced |
| GAS unreachable at submit | Submit blocked; board + queue preserved |
| Telegram send fails | `submitReport` returns failure, keeps Temp + Session, retry is safe |
| `/send` on an empty Temp | `Has Data?` routes to "No reports to submit" |
| Temp header deleted | GAS `ensureTempHeader_` rebuilds it; n8n clear preserves it |
| Corrupt JSON cell in Session | `safeJsonParse` falls back so one cell can't break all devices |

## 10. Key IDs (canonical source: `CONFIG` in `feeding_report_backend_v2.js`)

- **Sheet:** `1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc`
- **Tab gids:** Lookup `0` · Session `1038940935` · Temp `1965265218`
- **Lunch pen source (separate sheet):** master "Jot form Dog Details" `1OD8SQR2WxgO0nncXwBKYAkNv-qAhw018CXaH4kWgTDU`, Master tab gid `0`, col K = `Feeding Pen` (header-resolved, fallback index 10); col L = `Lunch Y?` (header-resolved, fallback index 11) — `Y` adds **any** dog (day-care or boarding) to the lunch board (universal gate 2026-06-19 / @26; boarding-only opt-in 2026-06-16 / @25); col H = `Last Name (Excel)` (owner surname, header-resolved, fallback index 7) feeds the name-join fallback. Old in-sheet B/T pen tab `1567330092` retired 2026-06-09.
- **Telegram:** chat `-1003653235960`, bot id `8436854999`
- **JotForm:** form `240143730611039`, EU instance (`eu-api.jotform.com`)
- **n8n workflow:** `yaBIrDOVbJTEMsH9`

> The `CONFIG` object at the top of `feeding_report_backend_v2.js` is the single source of
> truth for every ID, gid, and field map. If anything here disagrees with `CONFIG`, trust
> `CONFIG`.

## 4c. The medication leg (added 2026-08-25)

A dog needs medication when EITHER the boarding plan says
`feeding.medication === 'Yes'` for the joined record, OR staff have set `dog.prescription` on
the n8n session record. **Both signals, on all three surfaces** — tablet, plans TV, pens TV.

| | |
|---|---|
| Endpoint | `FRM_CONTRACT.BOARDING_PLANS_URL` + `?mode=feeding&token=` `FRM_CONTRACT.BOARDING_PLANS_TOKEN` |
| Budget | `PLAN_FETCH_TIMEOUT_MS` = 45s. **Never** the 12s session budget — that reproduces the 2026-08-04 self-abort. |
| Cadence | its own timer and its own in-flight guard (`planFetchInFlight`), never awaited inside the session path |
| Join | `normRxName`, exact on `dogName` and on `dogName + ownerSurname`, then a first-pipe-last token fallback that resolves TOWARD medication |
| Verdict | `dogNeedsRx` is tri-state: `true` red, `false` safe, `null` unknown. `null` never paints a tile safe. |
| Contract check | `scripts/check_contract.js` asserts the endpoint + token are identical across **four** files: `index.html`, `tv-plans/index.html`, `feeding_report_backend_v2.js`, `display/display.html` |

### Failure modes this leg survives

| Failure | Behaviour |
|---|---|
| Feed unreachable / non-JSON / no `dogs` array | OUTAGE. `dogNeedsRx` returns `null`, never `false`. Last-known-good is consulted for a POSITIVE verdict only, so a dog known to be medicated STAYS red. Banner raised. |
| `dogs: []` with **no** error | QUIET DAY, not an outage (`ok: true`, silent). Treating it as an outage parks a red banner on the TV all day. |
| `dogs: []` **with** an error, or arriving after a good roster on the SAME local day | OUTAGE. The confirmed roster is kept, not erased — otherwise every red vanishes with no warning. |
| 200 with `dogs` **and** an error (degraded) | usable, but `rxPlanUnavailable()` is true so the banner warns — a partial roster can be missing a dog's `feeding` block entirely. |
| Board EMPTY (between rounds) | the unjoined-medication list is suppressed on every surface. `submitReport` clears the board after each meal, so warning then fires most of the day. The in-round warning is kept. |

The banner **composes** with the board connection banner rather than replacing it, and titles
itself `CHECK MEDS` when only the plan feed is degraded — claiming the board is dead when it is
live is a lie staff act on. Full invariants: `HANDOVER.md` §5.
