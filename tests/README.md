# tests/ — the pre-deploy gate

```bash
bash tests/run.sh          # syntax + contract + backend + tablet.  MUST be green before deploying.
```

Nothing in this project runs locally as a server, so these harnesses load the **real source** and
replay acceptance scenarios against it:

| File | What it does |
| --- | --- |
| `backend_harness.js` | Loads the real `feeding_report_backend_v2.js` with Apps Script globals stubbed — `SpreadsheetApp`, `UrlFetchApp`, `CacheService`, `LockService`, `PropertiesService`, `Utilities`, and a controllable clock. Lets a test drive a flaky upstream, a broken cache, an unreadable sheet. |
| `backend.test.js` | 80 scenarios. |
| `tablet_harness.js` | Extracts the inline `<script>` from the real `index.html` and evaluates it with DOM/`fetch`/`localStorage` stubs and a scriptable fake network. |
| `tablet.test.js` | 50 scenarios. |

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

---

## Adding to the suite

When you fix a bug here, add the scenario that would have caught it — with a comment saying what
broke and who noticed. A test whose reason is undocumented gets deleted by the next person.

Two traps worth knowing, both hit on 2026-08-04:

1. **A stubbed Apps Script has no write-visibility semantics.** The backend buffers Sheet writes
   while `CacheService` applies immediately; a harness can't see that unless you instrument it
   deliberately. 30/30 passed while a silent data-loss bug sat in the diff.
2. **A green suite is not a deployed system.** `CLAUDE.md`'s live-edit rule still applies: after
   deploying, exercise the real path and read the real response.
