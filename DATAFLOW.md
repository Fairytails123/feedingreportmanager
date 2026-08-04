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
| **TV display** | read-only board mirror | source **in this repo** (`display/display.html` + `shared/contract.js`, since 2026-07-26); published via `scripts/publish_display.sh` to the Pages repo `Fairytails123/frmdisplay` (the TV's URL) |
| **White Board project** | roster source for "Add Dogs for Today" | a *separate* GAS app + sheet `1kQsNXee…` |

## 4. The map

```
                        ┌──────────────────────────────────────────────────────┐
                        │          GOOGLE SHEET  (the shared state bus)          │
                        │  Lookup │ Session (live) │ Temp │ Meta (version+count) │
                        └──────────────────────────────────────────────────────┘
                                        ▲    ▲    ▲
                    only Apps Script reads/writes the Sheet
                                        │    │    │
                        ┌───────────────┴────┴────┴───────────────┐
                        │       GAS Web App   (single /exec URL)   │
                        │   doGet(?action=) / doPost(data.action)  │
                        └──┬──────────────┬───────────────┬────────┘
        poll + POST edits  │              │ posts review  │ server-side reads
     ┌─────────────────────┘              │ summary       │ (White Board project:
     │                     │              ▼               │  check-in/out + loadToday)
┌────┴─────┐       ┌───────┴─────┐  ┌──────────┐          ▼
│ Tablet UI│       │ TV Display  │  │ Telegram │   ┌──────────────────┐
│index.html│       │  frmdisplay │  │  group   │   │  White Board app │
└──────────┘       └─────────────┘  └────┬─────┘   └──────────────────┘
 staff EDIT         read-only             │ human reads + replies /send
                                          ▼
                                    ┌──────────┐  reads Temp tab   ┌──────────┐
                                    │   n8n    │─────────────────▶ │ JotForm  │─▶ emails
                                    │ workflow │  POST submission  │ (eu-api) │   parents
                                    └──────────┘                   └──────────┘
```

Every arrow into GAS hits one endpoint (`/exec`). GAS chooses what to do by switching on
`?action=` for reads (`doGet`) and `data.action` for writes (`doPost`). Every handler
returns `{success, …}` — it never throws an error back to the client.

## 5. The three Sheet tabs (the state bus)

| Tab | gid | Role |
|-----|-----|------|
| **Lookup** | `0` | Permanent. `Dog Name \| Parent Email \| Parent Name`. Source of truth for emails. |
| **Session** | `1038940935` | Live editing state (13 columns) shared across tablets + TV. Re-synced ~every 5s. Column 13 = `Position` (within-pen feeding order). |
| **Temp** | `1965265218` | Submission staging (7 columns) that n8n reads on `/send`. Row 1 is a load-bearing header. |

(Lunch pen side is **no longer** in this sheet — as of 2026-06-09 it comes from the **external** master "Jot form Dog Details" sheet `1OD8SQR2…`, col K; see Phase 2. The old B/T pen tab `1567330092` here is retired/deleted.)

---

## 6. The sequence, phase by phase

### Phase 0 — Boot (tablet load)
`initialLoad()` runs, in order:
1. `loadQueue()` — restore the **durable edit queue** from localStorage (`feedingManager.queue.v1`), so unsynced edits survive a refresh.
2. **GET `?action=getDogList`** → GAS reads **Lookup** → names + parent emails.
3. **GET `?action=getSession`** → GAS reads **Session** → `applyRemoteState()` paints the board.
4. `flushQueue()` — push up anything queued while offline.
5. Start the **5-second poll** (`pollForUpdates`) and a lighter **7-second heartbeat** (`getSessionVersion`).

### Phase 1 — Every local edit (add dog, set amount, medicine, drag, change meal)
Edits do **not** POST directly. They go through a durable queue:

```
edit → syncAddDog/UpdateDog/DeleteDog/MealType → enqueue {op, dogId, payload}
     → save queue to localStorage → flushQueue() → POST to GAS → GAS writes Session tab
```

- The **queue owns ordering and retry**, not the call site. It drains in order, removes an
  item only after its POST succeeds, **stops on the first failure** and retries next cycle,
  and **drops an item after 5 rejections** so one bad edit can't jam the whole queue.
- The **5s poll** GETs `?action=getSession`, and `applyRemoteState()` **merges** the server
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

| Action | Method | Reads | Writes | Returns |
|--------|--------|-------|--------|---------|
| `getDogList` | GET/POST | Lookup | — | `{success, dogs:[{name,email,parentName}]}` |
| `getSession` | GET/POST | Session + Meta | (self-heal only) | `{success, dogs:[…], mealType, version, count}` |
| `getSessionVersion` | GET | Session + Meta | (self-heal only) | `{success, version, count}` (lightweight heartbeat) |
| `getTodayPlan` | GET/POST | Staff Board `Today` tab **direct** (web app = fallback) + check-in/out feed + master pen sheet (col K) | — | `{success, mealPeriod, today, dogs, skipped, counts, rosterSource}` — **`success:false` on a failed read, never an empty day**; `+ stale, capturedAt, upstreamError` when a last-known-good copy is served; `+ cached` on a cache hit. `?fresh=1` bypasses the cache |
| `dedupeSession` | GET | Session | Session (deletes duplicate rows) + Meta bump | `{success, removed, remaining}` — recovery for a tab that accumulated duplicate `Dog_ID` rows |
| `addDog` | POST | Session (id lookup) | Session (**update-or-insert**, never blind append) + Meta bump | `{success, dogId, deduped}` — **no version**. Idempotent by `Dog_ID` since @34 |
| `updateDog` | POST | Session | Session (one row) + Meta bump | `{success, dogId}` — **no version** |
| `deleteDog` | POST | Session | Session (delete row) + Meta bump | `{success, dogId}` — **no version** (20s lock wait) |
| `setMealType` | POST | Session | Session (all rows) + Meta bump | `{success, mealType}` — **no version** |
| `submitReport` | POST | POST body / Lookup / Temp | Temp (locked) → Telegram → (cond.) clear + Meta bump | `{success, telegramSent, sessionCleared, dogsProcessed}` |
| `clearSession` | POST | — | Session (delete dogs, keep header) + Meta bump | `{success, version}` — the ONE write that keeps `version` |
| `repairTemp` | GET | Temp | Temp (rebuild header, locked) | `{success, dogRows}` |

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
