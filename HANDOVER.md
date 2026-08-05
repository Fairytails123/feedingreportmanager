# HANDOVER — read this before changing anything

Last updated: **2026-08-05**, after the @36 migration. This file exists to stop the next session
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
| change the n8n session workflow | `LIVE=1 bash tests/run.sh` **after**. Validation is not proof — see §4. |
| change `index.html`, the backend, or the display | `bash tests/run.sh` — must be green. Never hand-deploy. |
| touch polling, the queue, or connection state | read `CLAUDE.md` → "One version-first poll" and `tests/tablet.test.js` **S13/S14/S21**. Those three tests are the guard rails. |
| move a session call back to Apps Script | don't — S21 and `check_contract.js` will fail, and they are right. |
| add a reader of the Session **tab** | don't — it is a mirror. Read n8n. |
| edit any n8n workflow | load the `n8n-gotchas` skill. Every entry is a production bug that passed validation. |
| edit any Apps Script | load the `gas-gotchas` skill. Same. |
| deploy the backend | bump the version string, then smoke-check — and **retry 2–3×**, `/exec` is genuinely flaky. |

## 4. Things that passed validation and were still broken

Both of these are why §3 says "validation is not proof".

1. **The n8n Data Table node advertises a `table/clear` operation its runtime router does not
   implement.** `clearSession` returned an empty body and silently left the board populated.
   `n8n_validate_workflow` reported 0 errors. Use `row/deleteRows` with an always-true filter.
2. **The first sheet-mirror design (clear-then-append) corrupted the sheet.** Six rapid writes each
   spawned a mirror chain, they interleaved, and a 2-dog board mirrored as **6 rows with
   duplicates**. It is now ONE atomic fixed-height range write (`A2:M201`). Never reintroduce a
   separate clear step.

Historical siblings, all documented in `CHANGELOG.md`: a green 30/30 suite shipped a silent
data-loss bug (2026-08-04); an upstream outage was reported to staff as a quiet day for months; a
non-idempotent `addDog` put 37 rows on the board for 16 dogs.

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
- **The poll runs while EDITING and while OFFLINE.** Only the board *write* is gated on the edit
  pause. Re-gate the loop and you recreate the gap the deleted 7 s heartbeat used to cover.
- **Submit is enabled only when online with an empty queue.**

## 6. How to verify the whole thing is alive

```bash
bash tests/run.sh                 # offline gate: 80 backend / 69 tablet / 9 display + contract
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
| End-to-end data flow + endpoint tables | `DATAFLOW.md` |
| Dated history and why each change happened | `CHANGELOG.md` |
| Why each test exists (do not delete without reading) | `tests/README.md` |
