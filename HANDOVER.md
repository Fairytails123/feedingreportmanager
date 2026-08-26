# HANDOVER — read this before changing anything

Last updated: **2026-08-26**, after the prescription-medication port to the pens TV, the tablet empty-board fix, and the TV-harness retry that had been making the gate a ~30% coin flip (see §4). Previous major revision: 2026-08-05, the @37 UI redesign on top of the @36 migration. This file exists to stop the next session
undoing work that took a day and an outage to get right. It is deliberately short. If you read
nothing else, read §1 and §2.

---

## 1. The one thing that is most likely to be got wrong

**The live feeding board is NOT in the Google Sheet. It is in n8n on the VPS.**

- Webhook: `https://auto.thefairytails.co.uk/webhook/feeding-session`
- Workflow: `hdGUbrd0PffVnwDS` — "Feeding Session API (v3 hot path)"
- Data Tables: `feeding_session` = `nnbHmglWVbneFigg`, `feeding_meta` = `5TGDqjRVlrczGUgm`
- The Sheet's **Session tab is a best-effort MIRROR** that n8n writes after answering the client.

Apps Script keeps exactly three endpoints: **`submitReport`, `getTodayPlan`, `getDogList`**.
Everything else about the live board goes to n8n.

Older docs, older commits and your own instincts will all say "the Session tab is the real-time
sync state". That was true until 2026-08-05. It is not true now.

## 2. Before you "improve" the sync layer — the measurement that decided it

Someone will eventually propose caching, or moving the session back, or making polling cleverer.
Here is the data, measured live on 2026-08-05, same test both sides:

| | Apps Script `/exec` | n8n on the VPS |
|---|---|---|
| median / mean | 4.5–8.7 s | **0.70 s** |
| worst | **55.6 s** | **1.83 s** |
| failures | ~40% past the tablet's 12 s abort, plus Google 404s | **0 in ~40 calls** |

**The decisive experiment:** a bare `/exec` ping that does *no spreadsheet work at all* was just
as slow (55.6 s worst). So the bottleneck was **Apps Script's dispatch layer** — not the data, not
the code, not the sheet. The plan at the time was to cache `getSessionVersion` so it never opened
the spreadsheet; that would have achieved **nothing**. Apps Script allows ~30 simultaneous
executions **per Google account**, shared with Staff Board, Training Planner, Boarding API,
Grooming and Order list — they starve each other.

Against a 12 s client abort, a ~40% slow rate is exactly what staff reported as *"connection
lost"*: the tablet was aborting **itself**.

**Measure before you migrate anything else.** That one ping saved a day of building the wrong fix.

## 3. Tripwires — doing X? do Y first

| About to… | Do this first |
|---|---|
| restyle anything, or "match the design spec" | read `design_handoff_feeding_board/AS-BUILT.md`. The shipped UI differs from that folder's spec **on purpose** in ~6 places, including the portion control being a `<select>` (owner decision). |
| touch the drag engine, or any tile CSS | load `frontend-gotchas`, run `node tests/android-scroll.smoke.mjs` (real CDP touch: scroll + drag + row swipe), then re-test **on a real Android device**. A mouse cannot catch this class — that is why it was rewritten (@37). |
| set `overscroll-behavior` back to `none` (or `contain`) on html/body | don't — either value kills **vertical scroll chaining out of `.fb-pens`** on Android Chrome, so a populated board can't scroll at all (2026-08-10 bug). It must stay `x: none; y: auto`. `node tests/android-scroll.smoke.mjs` proves it either way. |
| touch `enqueue` / `flushQueue` | read `CLAUDE.md` → the `it.inFlight` bullet, and `tests/tablet.test.js` **S22**. Merging into a payload that is already on the wire loses the edit silently. |
| change the n8n session workflow | `LIVE=1 bash tests/run.sh` **after**. Validation is not proof — see §4. |
| change `index.html`, the backend, or the display | `bash tests/run.sh` — must be green. Never hand-deploy. ⚠️ **That is necessary, not sufficient:** `run.sh` runs NO `tests/*.smoke.mjs`, and `gate.ps1` is not in this repo. If you touched anything medication-related also run `node tests/display-rx-red.smoke.mjs` (38) and `node tests/tablet-rx-empty-board.smoke.mjs` (6) — they are the ONLY guards for the red. |
| touch polling, the queue, or connection state | read `CLAUDE.md` → "One version-first poll" and `tests/tablet.test.js` **S13/S14/S21**. Those three tests are the guard rails. |
| move a session call back to Apps Script | don't — S21 and `check_contract.js` will fail, and they are right. |
| add a reader of the Session **tab** | don't — it is a mirror. Read n8n. |
| edit any n8n workflow | load the `n8n-gotchas` skill. Every entry is a production bug that passed validation. |
| edit any Apps Script | load the `gas-gotchas` skill. Same. |
| deploy the backend | bump the version string, then smoke-check — and **retry 2–3×**, `/exec` is genuinely flaky. |
| **`git push origin main` in THIS repo — for ANY reason, including a docs-only commit** | **that IS the tablet deployment.** GitHub Pages serves this repo's `index.html` to the staff tablet, so a push ships every merged commit that is an ancestor, whether you meant to or not. It happened on 2026-08-20: a tracker-doc push put the prescription-medication feature live. **Before pushing: check the live board is empty** (`curl -H 'Content-Type: application/json' -d '{"action":"getSessionVersion"}' https://auto.thefairytails.co.uk/webhook/feeding-session` → `count:0`) **and deploy outside feeding windows.** If you only want the docs live, there is no such thing here — push the lot deliberately or not at all. |
| publish the plans TV (`bash scripts/publish_plans_tv.sh`) | it pushes via a TEMP clone, so afterwards **`git pull` in `..\Dog feed requirement display`** or your local copy is silently behind what is live — and `tests/canonical-sources.smoke.mjs` will fail against your stale working copy rather than against Pages. Then **refresh the browser on the TV itself**; it never reloads on its own. |
| touch anything about prescription medication (red tiles, the join, the acknowledgement) | read §5's medication invariants first. The rule that matters: **an ambiguous name match must resolve TOWARD medication.** A build that passed 41 checks still let a medication dog render with no red because ambiguity returned a confident "no medication". `tests/rx-medication-warnings.smoke.mjs` reproduces it. |
| change `tv-plans/index.html` | its hash is pinned in three suites as `CANONICAL_PAGE_SHA`, and `PUBLISHED_PAGE_SHA` separately tracks what Pages serves. Re-pin CANONICAL when you change the page; re-pin PUBLISHED only **after** publishing. Never "fix" a mismatch by copying one over the other — the mismatch is the signal that the TV is out of date. |
| write or edit any `tests/*.smoke.mjs` | read `tests/README.md` → "Rules for writing a suite here". A permanent suite may only assert what stays true after its own task merges, and must fail for the right reason. |
| change the **pens TV** (`display/display.html`) | it is no longer a pure n8n reader — since 2026-08-25 it fetches the boarding-plan feed on its own timer, with its own in-flight guard and its own 45 s budget. Read §5's medication invariants, run `node tests/display-rx-red.smoke.mjs` (38 checks), then publish with `bash scripts/publish_display.sh` — and **refresh the browser on the TV itself**. |
| "tidy up" the empty-board guard — `rxMedicationPlanDogsNotOnBoard()` on the **tablet**, `rxPlanMedicationDogsNotOnBoard()` on the **pens TV** (yes, the two names are transposed — grep for both) | don't. It looks like a redundant early return. It is the fix for a safety warning that otherwise fires **most of the day**, because the board is cleared after every meal. Pinned by test NAME, not number: `tablet-rx-empty-board.smoke.mjs :: empty board raises no unjoined warning` + `:: in-round a missing medication dog is still named`, and `display-rx-red.smoke.mjs :: banner an empty board raises no unjoined-medication warning` + `:: banner a plan medication dog that joins no tile is named`. Both halves matter: suppression without the in-round half is just a deleted warning. |
| spawn `bash` from any `tests/*.smoke.mjs` | use the `resolveBash()` helper the existing suites carry — **never a bare `'bash'`**. Bare `bash` resolves to the distro-less System32 WSL shim when the gate spawns node from PowerShell, and the step dies with `execvpe(/bin/bash) failed` having tested nothing. It passes when YOU run it (Git Bash) and fails in the gate, which is the worst possible failure shape. |
| write a test that shells out and reports only a tail of the output | print enough to identify WHICH sub-suite failed. Truncating to the last 250 chars hid a real, reproducible harness defect for a full day (2026-08-25) — every failure looked like unattributable noise. |
| conclude a gate failure is "flaky" | **prove it before you say it.** On 2026-08-25 that word was used twice, wrongly, for a real defect. Capture the FULL output, identify the failing scenario by name, and check whether it is the same one each time — a different arbitrary one each run means the page never rendered; the same one means logic. See §4. |

## 3b. The @37 redesign (2026-08-05) — what it did and did not change

The whole UI is now the **Organic** design system (`design_handoff_feeding_board/` is the source
of truth) on all three surfaces, and the drag engine is a rewrite (`FRMDrag`). **Nothing in §1,
§2 or §5 changed** — same endpoints, same queue semantics, same budgets, same version contract.

Two things worth knowing before you touch it:

- **The redesign uncovered a silent data-loss race in the mutation queue** that predates it:
  `enqueue` merged an edit into a payload `flushQueue` had already serialised and was about to
  discard. Live repro: ½ → Medicine → "Metacam" landed only the ½. Fixed with `inFlight`; see
  §5 and `tests/tablet.test.js` **S22**. It was found by exercising the *live* board, not by the
  suite — which is the whole point of §4 below.
- **~~The Android drag has not been proven on a real device yet.~~ CLOSED 2026-08-10** — Kam confirmed it on his own Android phone the morning of the `overscroll-behavior` fix; `tests/android-scroll.smoke.mjs` now guards it with real CDP touch events. Left here because the *class* of bug (mouse testing cannot see it) is still true. Everything else is verified;
  this one cannot be, from a desktop browser. It is the open item.

## 4. Things that passed validation and were still broken

Both of these are why §3 says "validation is not proof".

1. **The n8n Data Table node advertises a `table/clear` operation its runtime router does not
   implement.** `clearSession` returned an empty body and silently left the board populated.
   `n8n_validate_workflow` reported 0 errors. Use `row/deleteRows` with an always-true filter.
2. **The first sheet-mirror design (clear-then-append) corrupted the sheet.** Six rapid writes each
   spawned a mirror chain, they interleaved, and a 2-dog board mirrored as **6 rows with
   duplicates**. It is now ONE atomic fixed-height range write (`A2:M201`). Never reintroduce a
   separate clear step.

3. **A medication dog rendered with NO red and NO warning — while 41 acceptance checks passed
   (2026-08-20).** When a board dog's name matched more than one plan entry, the lookup returned
   "no plan found", which the caller turned into a confident *"this dog needs no medication"* —
   visually identical to a genuinely medication-free dog. Not hypothetical: the plans feed really
   does contain same-name collisions, and the TV's own `deduplicateTagged` has always resolved
   them **in favour of medication**. Found by the blind review tracing paths no test covered.
   Ambiguity now resolves toward the medicated candidate; `tests/rx-medication-warnings.smoke.mjs`
   reproduces the collision. **Lesson: when the cost of a miss is asymmetric, the ambiguous case
   must fail LOUD, never quietly resolve to the cheap answer.**
4. **A whole suite reported green while 19 of its checks never ran (2026-08-20).** A UTF-8 BOM
   (PowerShell 5.1 `Out-File -Encoding utf8`) made Node reject an oracle JSON file, and the
   comparison loop sat behind `if (oracle)` — so the run printed 107/109 with the real
   verification simply absent. Its mirror image also happened: a test that reached for the wrong
   interface (`h.rx` instead of `h.api.rx`) failed *every* behavioural check **without ever calling
   the implementation**. **A check that cannot fail, and a check that cannot pass, are both lies.
   Verify a new test fails for the RIGHT REASON before trusting it.**
5. **A publish would have rewritten every line of a public page (2026-08-20).** `core.autocrlf=true`
   checks the TV page out as CRLF while git's blob — and the live page — are LF. The publisher
   copied the *working tree*, so publishing would have pushed a 2,222-line whole-file diff on a
   page whose content had not changed. **Hash a publisher's STAGED payload against the git blob,
   never against the working tree.** (`assemble_display.js` had always normalised; the new script
   had to learn it.)

Historical siblings, all documented in `CHANGELOG.md`: a green 30/30 suite shipped a silent
data-loss bug (2026-08-04); an upstream outage was reported to staff as a quiet day for months; a
non-idempotent `addDog` put 37 rows on the board for 16 dogs.

### The gate itself was a ~30% coin flip on correct code (found 2026-08-25, fixed 2026-08-26)

`tests/tv-plans/build_and_run.ps1` retried the DUMP-FILE READ, not the Chrome LAUNCH:

```powershell
for ($try = 0; $try -lt 10; $try++) {
  try { $domText = [IO.File]::ReadAllText($dumpFile); break } catch { Start-Sleep 500 }
}
```

It looks like a retry and guards the wrong failure. When headless Chrome wrote an **empty** dump,
`ReadAllText` SUCCEEDED, returned `''`, and broke on the first iteration — Chrome was never
re-run, and the scenario was scored a hard `NO TITLE FOUND`. Measured: **~18% of `run.sh`
executions lost one ARBITRARY scenario** (`fail_nocache`, `midnight`, `ok_toggle` on separate
occasions — a *different* one each time, which is what ruled out scenario logic). The gate runs
the suite **six times**, so P(green) was about `0.82^6 = 30%`. Three gate runs that day went
fail, pass, fail on code that was correct throughout.

Two lessons worth more than the fix:

- **A retry that protects against the wrong failure is worse than none** — it makes the real
  failure look handled. The read could never fail in the way that actually happened.
- **"Flaky" was asserted twice, wrongly, before anyone looked at the full output.** The first
  explanation ("Chrome contention from six back-to-back suite runs") was disproved by a single
  standalone run failing. A gate that fails ~1 in 3 for reasons nobody has read is a gate people
  learn to re-roll — which is how a real failure eventually gets laundered into a pass.

The fix retries the whole launch (3 attempts, fresh `--user-data-dir` each time, stale dump
deleted first) and is **loud**: `RETRY <scenario>` and `RETRY EXHAUSTED`. It was proved by a
negative control — `$env:FTBOARD_CHROME` pointed at a stub that emits nothing on first call —
not by sampling: six consecutive green runs proved nothing, because six passes was ~30% likely
anyway.

## 5. Invariants — each one is a bug that already happened

- **ONE version source.** `getSession` and `getSessionVersion` must serve the *same stored*
  version. Two sources can never compare equal and pin every client in permanent fast mode.
- **Mutation responses carry NO `version`; `clearSession` DOES.** The tablet assigns the latter
  unguarded — omit it and the poll gate is poisoned with `undefined`. Return it on mutations and a
  device skips remote edits it never applied.
- **Partial updates write only the changed columns.** Otherwise two tablets editing different
  fields of one dog clobber each other.
- **`addDog` is idempotent by `dog_id`.** A retrying client makes every write endpoint an
  idempotency requirement — a client abort is indistinguishable from a failure even when the
  server landed the write.
- **The queue never merges into an item that is already on the wire** (`it.inFlight`), and
  removes finished items **by identity, never by `shift()`**. Both were silent data loss (@37).
- **The poll runs while EDITING and while OFFLINE.** Only the board *write* is gated on the edit
  pause. Re-gate the loop and you recreate the gap the deleted 7 s heartbeat used to cover.
- **Submit is enabled only when online with an empty queue.**

### Prescription medication (2026-08-20; extended to the PENS TV 2026-08-25 — a missed dose is the harm being prevented)

> Until 2026-08-25 these rules lived only on the tablet. The **pens TV** — the screen staff
> actually read when putting dogs into kennels — read ONLY the n8n session and so could never
> see plan-declared medication. A boarding dog whose medication came from the plan showed as a
> plain tile there while the tablet showed it red. **Both surfaces now implement the same union
> and must stay in step.** If you change one, change the other or record why not.

- **An ambiguous name match resolves TOWARD medication.** If a board dog matches more than one
  plan entry and *any* of them is medicated, that dog is red. Returning "no match" here once
  produced a confident "no medication" and hid a dog entirely. Never trade a red for tidiness.
- **A failed, empty or stale plan read is NEVER "no dog needs medication."** It raises a visible
  banner. Plan-medication dogs that could not be joined to the board are named. This is the same
  rule as "a failed read is never an empty day", applied where the cost is a missed dose.
- **Acknowledging never clears the red.** The red tracks *medication is attached*; the
  acknowledgement tracks *a human has seen it*. They are different facts and must stay separate.
- **The acknowledgement must never live on the dog object.** `applyRemoteState` rebuilds every dog
  from an explicit field whitelist, so anything not in that literal is dropped within ~5 s. It
  lives in `localStorage['feedingManager.rxAck.v1']`, keyed dog + date + meal.
- **The red is the union of plan-declared and staff-flagged.** A one-off vet medicine the owner's
  form never mentioned must still read red.
- **Red applies at EVERY feed.** The plan has no structured per-meal field — `medicationDetails`
  is free text like "1 AM 1 PM". Parsing it to narrow the warning would turn a parsing miss into a
  hidden dose. Fixing this properly needs a new field on the requirements form.
- **The warning modal fires only for PLAN-declared medication**, never for a prescription the
  staff member has just ticked. A modal that fires on your own input teaches people to dismiss
  modals unread — which would disable the whole feature.
- **Anything that re-renders the board from an async callback must check `isDragActive()`.** The
  plan fetch does. A re-render mid-drag replaces the captured tile, fires `pointercancel`, and
  drops the dog somewhere nobody asked for.

**Added 2026-08-25/26, from the pens-TV port and its blind reviews. Each is a defect that was
caught in review, not in production — which is the only reason they are cheap to read here.**

- **The medication banner EXTENDS the board banner; it never replaces it.** The two failure
  modes CORRELATE — one TV network drop takes the session feed and the plan feed down together —
  so a medication message that pre-empts the board message destroys the "showing the board from
  HH:MM" as-of time in exactly the scenario the banner exists for. Compose into parts; hide only
  when every part is empty. The title must also say which channel is degraded (`CHECK MEDS` vs
  `NOT LIVE`) — claiming the board is dead when only the plan feed is stale is a lie staff act on.
- **An empty roster with NO error is a QUIET DAY, not an outage.** The rule is exactly the
  plans-TV rule: `usable = dogsOk && (dogs.length > 0 || !error)`. Getting this wrong parks a red
  banner on the TV **all day** on a day with no boarding dogs, and permanently steals board
  height. That is the 2026-08-04 "a quiet day is not a failure" pattern, and the first
  implementation shipped with it inverted because the CONTRACT said so — the contract was wrong.
- **...but an empty roster that ARRIVES AFTER a good one, on the same local day, is suspicious.**
  A 200 with `dogs: []` and no error must not erase a confirmed roster: that would drop every red
  with no warning at all — a confident "no medication" produced by a transition. Keep the old
  snapshot, go not-ok, explain it. It must self-release on the next local day or it sticks.
- **A retained last-known-good snapshot is read for a POSITIVE verdict only.** During a plan
  outage, a dog the last good snapshot says is medicated stays red; everything else returns
  `null`, never `false`. Preserving a snapshot and then never reading it is worse than not
  keeping one — the TV silently drops the red while the tablet keeps it, and the two surfaces
  disagree again, which is the whole defect this work existed to remove.
- **The plan fetch must NOT use the session budget.** `PLAN_FETCH_TIMEOUT_MS` (45 s) must never
  equal `FRM_CONTRACT.FETCH_TIMEOUT_MS` (12 s). The boarding feed is legitimately slow
  (2.8–33 s measured); applying 12 s reproduces the 2026-08-04 defect where the client aborted
  ITSELF and the resulting `AbortError` was misread as a network fault.
- **The unjoined-medication warning is SUPPRESSED when the board is empty — on BOTH surfaces.**
  `submitReport` clears the board after every meal, so an empty board is the normal
  between-rounds state. Warning then names every medication dog staying today, all day, and
  staff learn to swipe past a safety warning. Keep the IN-ROUND signal: a medication dog missing
  from a board that HAS dogs on it is still named. (Owner decision, Kam 25/08. He was offered a
  meal-aware variant — at Lunch only "Lunch Y" dogs are on the board — and rejected it: the
  tablet has no Lunch-Y data and a parsing miss there would HIDE a dose.)
- **The two surfaces key emptiness differently, on purpose.** The tablet uses the module-level
  `dogs` array; the pens TV uses pen membership (`PEN_ORDER.some(...)`). So dogs staged but not
  yet penned make the tablet warn and the TV stay quiet. That divergence favours over-warning on
  the surface staff are acting on, and they converge the moment a dog is penned. Do not "fix" it
  by making the tablet key on pens — `tests/tablet-rx-empty-board.smoke.mjs` will fail, correctly.
- **A degraded payload (dogs AND an error) must warn.** It can be missing a dog’s `feeding`
  block entirely, so a confident `false` for that dog is exactly the wrong answer.
- **The red tile carries ONE medication mark.** The terracotta `indicator-p` pill is suppressed
  when a tile is red — dark brown on red is illegible at TV distance, and two marks for one fact
  is how people learn to read neither.

## 6. How to verify the whole thing is alive

```bash
bash tests/run.sh                 # offline gate: 80 backend / 82 tablet / 9 display + contract
LIVE=1 bash tests/run.sh          # + 27 live assertions against the real n8n API

# the live board
curl -H 'Content-Type: application/json' -d '{"action":"getSessionVersion"}' \
     https://auto.thefairytails.co.uk/webhook/feeding-session

# the backend (retry 2-3x — /exec is flaky)
curl -sL "https://script.google.com/macros/s/AKfycbwP74AXOe1cZmHKTxi9KbMhZJU48EHRFI7NQ6Og65_FcTVB1sMQuqgkPKIkr7Fm7e40mw/exec"
# expect: "Feeding Report API v2.6 - Live session moved to n8n; …"
```

`tests/live_api.test.js` refuses to run if real dogs are on the board, so it can never trample a
feeding round.

## 7. Known-imperfect, deliberately

- **Apps Script `/exec` is still flaky** for its three remaining endpoints. Their 45 s budgets
  absorb it. A failed smoke check is usually the platform, not your deploy — retry.
- **The GAS→n8n board clear on submit** could not be tested end-to-end without posting a fake
  report to the staff Telegram group. Failure mode is benign and visible (`liveBoardCleared:false`)
  and the tablet has a complementary clear. **Watch the first submit after any change here:** if
  the TV still shows a submitted round, this is the path.
- **The repo's `n8n_workflow_v2_corrected.json` is STALE** — the live workflow `yaBIrDOVbJTEMsH9`
  has 22 nodes including a flood guard the mirror lacks, and its Sheets credential is
  `K4WVdja5P4CN9Yo4`, not the ID written in `CLAUDE.md`. Trust the live workflow, not the mirror.
  Restore path for either workflow is n8n's own version history, not this repo.
- **The VPS is a single box.** It has been far more reliable than Google here, but it is one
  machine; if it dies, the live board is unreachable and the tablet queues edits locally.

## 8. Where the detail lives

| Need | File |
|---|---|
| Architecture, protocols, credentials, deploy commands | `CLAUDE.md` |
| The UI design spec — and where the build deliberately differs from it | `design_handoff_feeding_board/README.md` → **`AS-BUILT.md`** |
| End-to-end data flow + endpoint tables | `DATAFLOW.md` |
| Dated history and why each change happened | `CHANGELOG.md` |
| Why each test exists (do not delete without reading) | `tests/README.md` |
