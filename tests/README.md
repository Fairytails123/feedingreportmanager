# tests/ — the pre-deploy gate

```bash
bash tests/run.sh          # syntax + contract + backend + tablet + display + TV feeding plans.  MUST be green before deploying.
LIVE=1 bash tests/run.sh   # ...plus 27 assertions against the REAL n8n board (refuses to run mid-round).
```

Nothing in this project runs locally as a server, so these harnesses load the **real source** and
replay acceptance scenarios against it:

| File | What it does |
| --- | --- |
| `backend_harness.js` | Loads the real `feeding_report_backend_v2.js` with Apps Script globals stubbed — `SpreadsheetApp`, `UrlFetchApp`, `CacheService`, `LockService`, `PropertiesService`, `Utilities`, and a controllable clock. Lets a test drive a flaky upstream, a broken cache, an unreadable sheet. |
| `backend.test.js` | 80 scenarios. |
| `tablet_harness.js` | Extracts the inline `<script>` from the real `index.html` and evaluates it with DOM/`fetch`/`localStorage` stubs and a scriptable fake network. |
| `tablet.test.js` | 82 scenarios. |
| `tv-plans/build_and_run.ps1` | 20 headless-Chrome scenarios against `tv-plans/index.html`, covering dense boards, remote-control paths, failures, stale data, hostile text, rollover and screenshots. It protects the separately published `fooddata` TV surface from browser-only regressions that the stubbed tablet and display suites cannot detect. |
| `android-scroll.smoke.mjs` | **Standalone — NOT in `run.sh`** (needs the local Playwright chromium cache): `node tests/android-scroll.smoke.mjs`. Real CDP **touch** events against the served `index.html` in an emulated Android phone viewport, every external request aborted. The one class the stubbed harnesses cannot see: Chromium's touch scroll-latching/chaining. |

This formalises what `CLAUDE.md` already called the de-facto test step. It was throwaway before
2026-08-04; the day's outage is why it now lives in the repo.

---

## Why each group exists — do not delete these without reading

Every group below is a bug that reached staff. They are regression tests, not decoration.

**Tablet — `tablet.test.js`**
- **S1 negative control** — the pre-fix build must reproduce `"signal is aborted without reason"`
  on a 15s response. This is what proves a diagnosis rather than assuming one. Optional: needs
  `OLD_PATH` pointing at a pre-fix `index.html` (see the note at the top of the file).
- **S2–S4** — `getTodayPlan` is the one legitimately slow call. It gets its own 45s budget; every
  *other* GAS call must keep the standard 12s (S7 asserts both).
- **S9** — the stale-board warning must reach the **`confirm()` text**, not a toast: `confirm()`
  blocks the thread, so a toast fired first may never paint and staff would approve a stale board
  having seen nothing.
- **S10** — a repeat press sends `&fresh=1`, the staff gesture for "I just changed the whiteboard".
- **S21** — @36 routing, in BOTH directions: session calls must go to the n8n webhook and never
  to `script.google.com`, and `getDogList` must still go to Apps Script. This is the test that
  catches the migration silently unravelling — Apps Script /exec measured a 4.5–8.7s median with a
  55.6s peak and ~40% of calls past the client budget, so a session call drifting back onto it
  brings "connection lost" straight back.
- **S17–S20** — resilience against a BIMODAL backend: writes get a 45s budget, the version probe
  retries once before counting a strike, one tick counts exactly one strike, and a slow write no
  longer instantly kills the connection (it used to bypass OFFLINE_THRESHOLD entirely).
- **S22** — ⭐ the mutation queue must not lose an edit made **while a POST is in flight**.
  Found on the live board on 2026-08-05 by exercising the redesigned dog tile, which puts
  portion, medicine and supplements in one panel — so staff fire three edits inside one
  ~700ms round-trip. `flushQueue` serialises an item's payload when it POSTs it and removes
  the item on success, while `enqueue` merged later edits **into that same payload object**:
  they went out with nothing and were then thrown away. Live repro: tapping ½ → Medicine →
  typing "Metacam" landed only the ½, with no error anywhere. The n8n handler was innocent —
  a direct `updateDog` carrying the same fields wrote them fine, which is what isolated it.
  Two siblings fell out of the same read: a `delete` for a dog whose `add` was already on the
  wire was collapsed to "never synced, nothing to delete" and **orphaned the row on the
  server**; and `flushQueue` removed the completed item with `shift()` — "whatever is at
  index 0 *now*" — so an `enqueue` that rebuilt the array mid-flight made it discard a
  **different dog's** edit, unsent. Fix: an `inFlight` marker that `enqueue` refuses to merge
  into (cleared by `loadQueue`, since a reload means nothing is on the wire), and removal by
  identity rather than by position. All three predate the redesign; the redesign is what made
  them reachable in normal use. Negative-control tested against the pre-fix build: 5 of the 13
  checks fail there.
- **S11–S16** — the version-first sync loop (@35). S11/S12 are the point of the change: an unchanged
  board must cost ONE cheap `getSessionVersion` and a real change must still escalate to the full
  read. **S13 and S14 are the ones that matter** — they are regression guards for the properties the
  deleted 7s heartbeat used to provide. The old poll bailed out on `isSyncPaused()` and `!isOnline`,
  so if the merged loop is ever re-gated on either, an edit burst stops draining the queue (S13) or
  a dropped link becomes unrecoverable without the manual Retry button (S14). S13 also pins that the
  *board* is still protected mid-edit and that `lastSyncVersion` is left alone so the change is
  re-detected. S16 pins `isSyncing` as a real in-flight guard (it was vestigial before) so a slow
  12s call cannot stack ticks behind it — `heartbeatInFlight`'s old job.

**Backend — `backend.test.js`**
- **B** — ⭐ the big one. An upstream failure must **never** be reported as a successful empty day.
  For months a ~40% HTTP-404 rate on the whiteboard web app surfaced to staff as
  *"No Lunch dogs found on the whiteboard for today"*, so they hand-built the board during an
  outage. Root cause: `fetchJson_` returned `null` for **both** "failed" and "empty".
- **C** — the mirror of B: a genuinely quiet day must still be `success: true`. Fixing B by making
  everything an error would be its own bug.
- **D** — retry policy is deliberately **asymmetric**: no retry against the whiteboard (its
  failures take 16–43s so a retry can't clear the deadline gate, and the producer documents that
  it degrades under concurrent load), retry armed on the fast, healthy check-in/out feed.
- **G/H/K-P2** — last-known-good must never cross a date or a meal, and an **empty** LKG is
  refused: serving it would fire the stale warning *and* "no dogs found" together.
- **I** — a cache fault, an oversized value, or an unreadable pen sheet must degrade to a live
  read, never throw to the client.
- **K-P1** — zero `"Lunch Y?"` rows is a **legitimate quiet day**, not an outage. Treating it as
  one blacked the button out for a whole day with no override.
- **N** — the Session header must self-heal in **full**, not just the `Position` column. The live
  n8n `Clear Session (Cancel)` node is a `wholeSheet` clear (no `clear` parameter → the n8n default),
  so it takes row 1 with it. GAS reads Session by index and never noticed; n8n's Session read keys
  rows by row 1, so a wiped header makes it promote the first **dog** row to headers. Also pins the
  `getMaxColumns` guard — a hand-narrowed grid must degrade to a no-op, never throw out of every
  endpoint — and that the repair leaves the dog rows underneath untouched.
- **L** — the lunch roster is read **straight from the Staff Board sheet**; the web app is only a
  fallback. Asserts the two produce *identical* results, that a missing tab is never created
  (this app is a read-only guest in another project's workbook), and that unrecognised headers
  fall back rather than being read positionally.

**Android touch scroll — `android-scroll.smoke.mjs`** (standalone)
- The 2026-08-10 bug: `body { overscroll-behavior: none }` stopped Android Chrome chaining the
  vertical part of a touch gesture that starts inside `.fb-pens` (a horizontal scroll container)
  up to the page scroller — a populated board could not be scrolled up or down at all. Invisible
  to `tablet_harness.js` (no real compositor) and to mouse testing; only a dispatched CDP touch
  stream exercises the path. Four assertions: vertical flick on a tile scrolls, vertical flick on
  the pen background scrolls, a long-press drag still lands (and nothing wedges), a horizontal
  row swipe still works. Negative-control verified: fails 2/4 on the pre-fix build.
  `overscroll-behavior-y` must stay `auto` — `none` AND `contain` both reintroduce the bug.

---

## Adding to the suite

When you fix a bug here, add the scenario that would have caught it — with a comment saying what
broke and who noticed. A test whose reason is undocumented gets deleted by the next person.

Three traps worth knowing (1–2 hit on 2026-08-04, 3 on 2026-08-10):

1. **A stubbed Apps Script has no write-visibility semantics.** The backend buffers Sheet writes
   while `CacheService` applies immediately; a harness can't see that unless you instrument it
   deliberately. 30/30 passed while a silent data-loss bug sat in the diff.
2. **A green suite is not a deployed system.** `CLAUDE.md`'s live-edit rule still applies: after
   deploying, exercise the real path and read the real response.
3. **In a touch harness, measure client coordinates AFTER resetting scroll, never before.**

---

## The `*.smoke.mjs` suites (added 2026-08-19/20) — and what each one guards

`gate.ps1` runs **every** `tests/*.smoke.mjs`, so each of these executes on every future task
in this repo, forever. That is the point — and it is also the trap they each had to be fixed for.

| Suite | Guards |
|---|---|
| `android-scroll.smoke.mjs` | real CDP touch: scroll, drag, row swipe. `overscroll-behavior-y` must stay `auto`. |
| `tv-plans-absorb.smoke.mjs` | the TV page + its harness live in ONE place; the publisher stages the canonical bytes. |
| `tv-plans-eol-fix.smoke.mjs` | the publisher LF-normalises, so a publish can never rewrite every line of the public page. |
| `canonical-sources.smoke.mjs` | one maintained TV page; `fooddata` is a publish target; no competing boarding-script copy; the boarding drift checker stays read-only. Also reports whether the TV is showing the current design. |
| `rx-medication-warnings.smoke.mjs` | prescription medication is impossible to overlook — red on both surfaces, acknowledgement that never clears it, ambiguity resolving toward medication, and a failed plan read never meaning "no meds". |
| `display-rx-red.smoke.mjs` | (2026-08-25, 38 checks) the **pens TV** medication union: the join agrees with the tablet's exactly, a failed read is never "no medication", an empty roster with no error is a quiet day, a same-day empty never erases a confirmed one, the last-known-good is read for a POSITIVE verdict only, the banner COMPOSES with the board banner, and an empty board raises no unjoined warning. |
| `tablet-rx-empty-board.smoke.mjs` | (2026-08-26) the tablet says nothing about unjoined medication dogs when the board is empty — and still names them when a round IS in progress. Two halves; one without the other is the bug. |

## Rules for writing a suite here — each one is a real failure from 2026-08-19/20 (and 08-25/26)

1. **Assert only what stays true after your own task merges.** Two suites asserted
   "`index.html` unchanged on this branch" — correct scope control for *their* task, but once
   merged they were asserting that **no future task may ever touch those files**, and they
   produced three false failures on the very next task's correct work. Per-task scope control
   belongs in the contract's MUST-NOT list and the blind review, both of which are per-task.
2. **Never reference `.task/`.** It is archived when the task merges, so a seed-dependent suite
   starts failing `want null` on every later task — and one stale suite reddens the whole gate.
   Reference the **git blob** instead; it is durable and it is what actually gets published.
3. **One constant, one fact.** A single pinned hash once meant both "the repo's page" and "what
   the TV serves". Those diverge the moment source moves ahead of a publish. They are now
   `CANONICAL_PAGE_SHA` and `PUBLISHED_PAGE_SHA`, and the gap between them is *reported*, not
   hidden. Never resolve a mismatch by copying one over the other.
4. **Prove a new check fails for the RIGHT REASON.** Run it against the unfixed build and read
   the failure. Three real examples: a BOM made 19 checks silently skip while the suite read
   green; an ambiguity check used a single-token name that was rejected by an earlier guard so it
   never reached the logic it claimed to test; a suite reached for `h.rx` when the harness exposes
   `h.api.rx`, failing everything **without ever calling the implementation**.
5. **Watch for state leaking between checks.** One warning test failed against correct code
   because an earlier check had already acknowledged the same dog id. Use fresh ids.
6. **`tablet_harness.js`'s `EXPORTS` block is a TEMPLATE LITERAL.** A backtick in a comment there
   terminates the string and breaks every suite that uses the harness.
7. **Resolve `bash` explicitly on Windows.** A bare `bash` hits the distro-less WSL stub in
   `WindowsApps` and dies with `execvpe(/bin/bash) failed`; Git Bash is the one that works.
8. **Spawn-dependent checks must skip LOUDLY under `FTBOARD_SKIP_SPAWN=1`** (the Codex sandbox
   denies nested Chrome/PowerShell), and the operator must run the full suite outside it before
   the gate counts. A silent skip reads exactly like a pass.
   Coordinates captured in a scrolled page go stale the moment the scroll is reset — and if the
   bug under test is "scrolling doesn't work", the pre-fix build masks the harness bug entirely:
   `android-scroll.smoke.mjs` failed its own regression guards only *after* the fix landed,
   because the fix made the page actually move. Reset → settle (~150ms) → measure, per block.

### Four more, learned the hard way on 2026-08-25/26

**1. Never spawn a bare `'bash'` — use `resolveBash()`.** Every suite here that shells out
carries a `resolveBash()` that probes the Git Bash paths explicitly. A bare `'bash'` resolves to
the **distro-less System32 WSL shim** when `gate.ps1` spawns node from PowerShell, and the step
dies with `execvpe(/bin/bash) failed: No such file or directory` having tested nothing. The
failure shape is the worst kind: it PASSES when a human runs it (their shell finds Git Bash) and
FAILS in the gate. Cost: one full gate cycle plus a wrong diagnosis.

**2. If you shell out, print enough to identify WHICH sub-suite failed.** A suite that reports
only `exit=1` plus the last 250 characters turns every failure into unattributable noise. That
truncation hid a real, reproducible harness defect for a full day — the fix took twenty minutes
once the full output was finally captured. Print the failing section name, or write the full log
somewhere the operator can read it.

**3. Fixture dates must be computed RELATIVE to today, with LOCAL date arithmetic.** Anything
that compares against the real clock (`rxPlanDogIsStayingToday`) makes a hard-coded date a
time bomb: the suite starts failing on a specific future date, and because `gate.ps1` runs
**every** `tests/*.smoke.mjs`, one stale suite then fails every LATER task in this repo. Use a
local-day helper (`getFullYear`/`getMonth`/`getDate`), never `toISOString()` — the UTC day flips
at the wrong moment for this estate. A blind review caught exactly this two days before it
would have fired.

**4. No real customer data in a fixture — this repo is PUBLIC.** A dog's name, its owner's
surname and its prescription were committed here on 2026-08-25 and had to be purged from public
git history with a force-push. Sanitising the tip is NOT enough: the data stays in every earlier
commit, and a later push publishes the whole history. Fabricate values and keep the SHAPE that
the test actually needs (here: plan `dogName` as a single token plus a separate `ownerSurname`,
joined against a combined board `matchedName`). The matcher is name-agnostic, so nothing is lost.
