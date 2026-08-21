# Feeding Platform Integration — programme tracker

Plan of record: the **"One Feeding Platform"** assessment (Claude artifact, 2026-08-19,
https://claude.ai/code/artifact/f482bd9f-27b7-4489-b2e4-2781075cefb6). Kam approved
executing all phases on 2026-08-19. This file is the live status; update it whenever a
phase item lands.

**The two systems:** this repo (Feeding Report Manager — feeding *events*) and
`..\Dog feed requirement display` (DFRD — feeding *plans*, repo `fooddata`). They already
couple through DFRD's Apps Script `mode=checkinout` feed (shared token). Target: one
platform repo (this one), shared contracts/modules, three published screens, two data
planes kept (n8n hot / GAS cold). The OneDrive folder merge is the endgame, after Phase 1
has shipped and held.

## Phase status

| Phase | Item | Status |
|---|---|---|
| 0 Hygiene | Commit DFRD's dirty tree (2026-08-10 credential-extraction docs) | ✅ 2026-08-19 (`d14fee9`, pushed; diff checked secret-free) |
| 0 | Push both repos' stranded 2026-08-10 commits | ✅ 2026-08-19 (DFRD `244d145`, FRM `cdce144`) |
| 0 | Remove stale worktrees (DFRD `frosty-agnesi` + branch; FRM `optimistic-kilby` debris) | ✅ 2026-08-19 |
| 0 | DFRD `HANDOVER.md` | ✅ 2026-08-19 (`70bd373`, pushed) |
| 0 | Harness rescue + synthetic fixture (task `harness-rescue`, **Tier 3** — client PII) | ✅ **MERGED 2026-08-20** (`3a9e9d4`, Kam-approved, NOT pushed — DFRD local main is ahead of origin). Contract v3 after 2 critique rounds / 33 findings; 128 acceptance checks 0 fails on real Chrome; gate PASS ×2 incl. gitleaks; blind review APPROVE 0 blocking; 1 remediation cycle. Merged main re-verified green. Archive: `_dev-system\archive\Dog feed requirement display--harness-rescue-20260820-005728` |
| 0 | PII sweep of scratch artefacts | ✅ 2026-08-20 — 81 pre-task files deleted from `%TEMP%\ftboard-tests\`, incl. June renders of the `live` scenario (real customer data as pixels) |
| 1 Repo unification | Move DFRD page in as `tv-plans/` + publish script to `fooddata`; backend mirror in as `backend-boarding/`; extend `check_contract.js` (token, exec URLs, JotForm maps); carry Claude project memory | ⬜ after Phase 0 |
| 1A Repo unification | Copy the feeding-plans page and logo into `tv-plans/` byte-identically; move the sanitised 20-scenario harness into `tests/tv-plans/` | ✅ 2026-08-20 (source absorbed locally; live `fooddata` repo untouched) |
| 1A | Add `publish_plans_tv.sh` with contract-first, verbatim staging and SHA-256 dry-run proof | ✅ 2026-08-20 (`--dry-run` only; no clone, push or publish) |
| 1A | Gate the feeding-plans `API_URL` and `API_TOKEN` against the boarding backend mirror | ✅ 2026-08-20 (`scripts/check_contract.js`) |
| 1A | **EOL defect found by verifying merged main** (task `tv-plans-eol-fix`, Tier 1) | ✅ MERGED 2026-08-20 — the publisher staged the WORKING TREE copy, which `core.autocrlf=true` checks out as CRLF (90,511 B) while the blob and the live page are LF (88,289 B): a publish would have rewritten all 2,222 lines in the PUBLIC repo. Publisher now LF-normalises (as `assemble_display.js:29` always did); `.gitattributes` pins the page to LF + logo binary. 19 checks 0 fails; gate PASS |
| 1A | Phase 1A smoke made portable (same task) | ✅ 2026-08-20 — it referenced `.task/seed/`, archived at merge, so it failed `want null` on every LATER task and would have poisoned the gate repo-wide. Now references the git blob + pinned live hashes |
| 1A Canonical sources (R1) | Keep exactly one maintained TV page in `tv-plans/`; make `fooddata` a publish target only; remove its duplicate harness | ✅ 2026-08-20 — platform page and harness are canonical; sibling deduplication is local commit `34fd274`, NOT pushed |
| 1A Canonical sources (R2) | Keep live boarding GAS as truth; delete the old local mirror; mechanically check it against guarded deploy vehicle `Fairytails123/Boardingplan` | ✅ 2026-08-20 — mirror deleted in sibling commit `34fd274` (NOT pushed); `scripts/check_boarding_drift.sh` added; Boardingplan CI already refuses unknown live state and rolls back failed smoke tests |
| 1A publish | First publish to the unchanged `fooddata` Pages URL and byte-compare the served page | ⬜ deferred to Kam's explicit publish call — **now safe: dry-run proves the staged payload hashes to the live page exactly** |
| 2 Shared modules | `shared/name-match.js` + `shared/fetch-kit.js` (ES5), equivalence-tested, adopted per surface | ⬜ |
| 3 Symbiosis | Prescription-medication red tiles on TV and tablet; plan-data join, blocking tablet acknowledgement, failure banners and preview-sheet warning | ✅ delivered 2026-08-20 (`rx-medication-warnings`; 41 checks / 0 failures with real Chrome; not published) |
| 3 | Plan-vs-report flag in Telegram summary | ⬜ separate later contract |
| 4 Measured infra | Instrument checkinout/plans feeds 2 weeks → move to n8n ONLY on measured degradation; token rework | 🟡 **PAUSED MID-BUILD 2026-08-21 20:22 — see "Phase 4: exactly where it stopped" below.** Owner overrode the measure-first gate and asked to build now. Stage A is built but **INERT**: nothing runs, nothing consumes it, no consumer repointed. |
| Endgame | Merge the OneDrive folders (PII file disposed, memory carried on BOTH machines, redirect stub) | ⬜ after Phase 1 shipped + held |

## Kam's three requirements, 2026-08-20 — ALL MERGED (nothing pushed or published)

| Req | Delivered | Evidence |
|---|---|---|
| **R1 one canonical TV page** | `tv-plans/` is the ONLY maintained copy; `fooddata` is a publish target (its CLAUDE.md/HANDOVER.md are redirect stubs); its duplicate harness deleted | sibling `34fd274`, platform merge `9b34323` |
| **R2 live Apps Script = sole truth** | 3 copies → 2 (live truth + `Boardingplan` deploy vehicle). Unprotected local mirror DELETED after 3-way byte-verification. `scripts/check_boarding_drift.sh`: read-only, opt-in `BOARDING=1` | run against PRODUCTION: both sides `d5cc2ff8…`, exit 0 |
| **R3 prescription warnings** | Whole tile red on TV + tablet (plan-declared OR staff-flagged); blocking acknowledgement that NEVER clears the red and survives the poll; unacknowledged dogs on the mandatory preview; failed plan fetch = visible banner, never "no meds" | merge `973ddc3`; gate PASS ×8; gitleaks 6.06 MB clean; merged main re-verified rx 46/0, canonical 47/0 |

**Still Kam's:** publishing the TV (`bash scripts/publish_plans_tv.sh`) — the suite prints
"UNPUBLISHED CHANGES PENDING" until then; pushing either repo; and verifying the tablet's
red on the real device (only the TV can be screenshotted headlessly).

**R3 decisions locked** (D1–D6, archived contract): red = plan OR staff flag; red at EVERY
feed because the plan has no structured per-meal field (free text like "1 AM 1 PM" — parsing
it would turn a parsing miss into a hidden dose); the modal fires only for PLAN-declared
medication (one that fires on your own input trains people to dismiss modals); blocking
`confirm()` per the house rule; ack in `localStorage` keyed dog+date+meal, never on the dog
object. **Known limitation:** true per-meal precision needs a structured field on the
requirements form — same gap as the missing allergy field.

## Phase 4: exactly where it stopped (paused 2026-08-21 20:22, resume here)

**Nothing is live. Nothing is half-deployed.** The workflow is INACTIVE and has NEVER RUN;
the table is EMPTY; no consumer was repointed. Walking away permanently is safe — deleting
the two artefacts below returns the estate to its pre-Phase-4 state with zero effect on the
tablet, the TV or the boarding script.

### What exists on the VPS

| Thing | ID | State |
|---|---|---|
| Data table `boarding_feed_mirror` | `3XBHNDieDwURytuC` | created, **empty** |
| Workflow "Boarding Plans Mirror — Refresh (Phase 4)" | `SIpnV8ESIbBHjZYB` | created, **INACTIVE, never executed**; `n8n_validate_workflow` = 0 errors |

Table columns: `feed_key`(str) `payload`(str) `captured_at`(str) `ok`(bool) `source_ms`(num)
`error_text`(str) `dog_count`(num). **The n8n Data Table schema is IMMUTABLE via the API** —
to change a column you must create a new table.

### Scope decision already taken
Mirror **`mode=feeding` ONLY**. That is what the tablet and TV read directly, and it is what
carries the prescription-medication signal. The `checkinout` leg is consumed server-side by
the Apps Script feeding backend (GAS→GAS), so mirroring it would need a backend change for
much less benefit. Out of scope here.

### Design rules already encoded (do not "simplify" these away)
- **Apps Script stays the fallback.** Consumers will try n8n first and fall back to GAS on
  any doubt, so a bad mirror degrades to today's behaviour instead of breaking anything.
  This is what makes deploying it low-risk on any day.
- **The response is fetched as TEXT and `JSON.parse`d manually.** GAS sometimes answers with
  an HTML error page; a json-mode node would crash on it, and this turns it into a
  classified failure instead.
- **A failure NEVER overwrites the last good snapshot.** Failures are written under the
  separate key `feeding:error`. Mirrors the GAS-side rule that a failed read is never cached.
- **A 200 without a `dogs` array is an OUTAGE, not an empty day.** Writing it as a snapshot
  would confidently tell every consumer that no dog needs medication — the exact harm the
  medication feature exists to prevent.
- **Every run stopwatches Apps Script** (`source_ms`), so the measurement Phase 4 was
  originally gated on accrues whether or not the migration ever proceeds.

### Next steps, in order
1. **Run it manually once and READ THE EXECUTION** (`n8n_executions`). Validation passing
   proves nothing — see every entry in the `n8n-gotchas` skill. Specifically check the
   **Data Table node's OUTPUT SHAPE**: an upsert whose output echoes its input wrote NOTHING.
2. **Prove the snapshot equals the source**: compare the stored `payload` against a live
   `curl` of the GAS `?mode=feeding` URL. They must match.
3. Only then **activate** the schedule (30-minute cadence).
4. Build the serving webhook (planned name "Boarding Plans API"): read the row, and return
   `{dogs, dogCount, dateRange, lastUpdated, error, feedingError}` **plus** a `_mirror`
   block with `captured_at` / `age_ms` / `stale`. **If the row is missing or hard-stale
   (suggest >3h, i.e. ~6 consecutive refresh failures), return a NON-2xx** so consumers fall
   back to GAS rather than trusting an old board. Never return an empty `dogs` array as if
   it were an answer.
5. Repoint consumers **with the GAS fallback kept**, through the dual-model pipeline
   (source edits): `tv-plans/index.html` and the tablet's `BOARDING_PLANS_API_URL`. Note
   `scripts/check_contract.js` asserts those endpoint constants across three files — update
   the contract FIRST, then the copies.
6. Token rework (per-consumer credentials replacing the shared `ft-k9-board-2024-sec`) was
   always the tail of Phase 4 and is untouched.

### Timing note recorded at the pause
The owner's stated reason for it being a safe window ("it's the weekend") did not hold: it
was **Friday evening**, and for a boarding business **weekends are peak occupancy**, not
quiet. The build was done anyway at the owner's explicit override — safely, because Stage A
touches nothing live. **The step that genuinely needs a quiet window is step 5**, the
repoint. Check the live board is empty first:
`curl -H 'Content-Type: application/json' -d '{"action":"getSessionVersion"}' https://auto.thefairytails.co.uk/webhook/feeding-session`

## Findings worth keeping

- **A blind review beats a green suite for false NEGATIVES.** R3's first implementation
  passed 41 acceptance checks and still had a path where a dog needing medication rendered
  with NO red and NO warning: an ambiguous name match returned a confident "no medication".
  Found by tracing paths the tests never covered, and proved live by the shipped fixture's
  own collision pair plus the TV's `deduplicateTagged`, which has always resolved such
  collisions IN FAVOUR OF medication. Fix: ambiguity now resolves toward the medicated
  candidate. **When the cost of a miss is asymmetric, make the ambiguous case fail loud.**
- **A permanent suite may only assert what stays true after its own task merges.** Two
  suites asserted "index.html unchanged on this branch" — correct scope control for THEIR
  task, but the gate runs every `tests/*.smoke.mjs`, so after merge they asserted that no
  LATER task may touch those files, and produced three false failures on correct work.
  Per-task scope control belongs in the contract's MUST-NOT list and the blind review.
  (Same family as the `.task/seed` lesson below.)
- **One constant must not carry two facts.** The pinned TV-page hash meant both "the repo's
  page" and "what the TV serves". They diverge the moment source moves ahead of a publish —
  now `CANONICAL_PAGE_SHA` vs `PUBLISHED_PAGE_SHA`, with the suite printing
  "UNPUBLISHED CHANGES PENDING" so whether the TV is current is visible, not guessed.
- **Name contract seams from CODE READING, never memory.** R3's contract claimed an
  "existing submit `confirm()`"; there is none (`confirmSubmit` has no confirm; the one at
  ~2851 belongs to `addDogsForToday`). Cost a halt cycle — and the exploration report had
  ALREADY listed the only two confirm sites. The dual-model skill warns about exactly this.
- **Codex halting is the system working.** Three halts in R1–R3, all correct, none causing
  damage: cross-repo writes are outside the sandbox (and git metadata is deny-ACE'd, so it
  could never commit in a second repo); a contract described code that did not exist; a test
  could not see the interface it was testing. Every one was a flaw in what it was handed.
- **A test that fails WITHOUT calling the implementation is as bad as one that passes
  without it.** `h.rx` vs `h.api.rx` failed every behavioural check while never invoking the
  feature — the mirror image of the BOM false-positive below.
- **The old TV harness carried live customer names + medication as test literals** (its
  `photo` scenario). Caught by the Codex pre-flight critique before anything reached the
  PUBLIC `fooddata` repo. Seed sanitised (values fabricated, string lengths preserved);
  the derived `%TEMP%` artefacts (`harness_live.html`, `dom_live.html`, `shot_live.png`,
  `profile_live`) were deleted 2026-08-19.
- **The harness has 20 scenarios, not the 19 every doc claimed.**
- **A skipped check reads as a pass.** A UTF-8 BOM (PowerShell 5.1 `Out-File -Encoding utf8`)
  made Node reject the oracle JSON, so 19 oracle comparisons sat behind `if (oracle)` and
  never ran — the suite reported 107/109 green while the real verification was absent. Its
  sibling: `git status --porcelain` returns `""` on a clean tree, so `|| 'SENTINEL'`
  fallbacks made a check that could only pass on a DIRTY tree. Both were in the OPERATOR's
  own test assets, found only by running the thing for real.
- **Codex's sandbox denies nested spawns** (Chrome, and even git from Node): plan for the
  operator to run browser/spawn-dependent acceptance tests outside it, and make skips loud.
- **A test may only reference things that outlive its own task.** `.task/seed/` is archived
  at merge, so a seed-dependent acceptance suite starts failing on every LATER task in that
  repo — and the gate runs ALL `tests/*.smoke.mjs`, so one stale suite poisons the gate
  repo-wide. Reference the **git blob** (durable, and what actually gets published).
- **`core.autocrlf=true` makes the working tree lie about what you will publish.** The blob
  is LF; checkout gives CRLF. Any publisher that `cp`s the working tree pushes CRLF — a
  whole-file diff on a public repo. `assemble_display.js:29` had always normalised; the new
  publisher had to learn it. **Verify a publisher by hashing its STAGED payload against the
  blob, never against the working tree.**
- **Verify the MERGED result, not just the branch.** Both of the above only appeared after
  commit → merge → checkout; the branch was green throughout.
- **Name contract seams from CODE READING, never memory.** This task's contract claimed an
  "existing submit `confirm()`" that did not exist, even though the exploration report had
  already identified the only two `confirm()` call sites. That unsupported seam cost a full
  halt cycle; the mandatory path proved to be `submitReport()` → `showPreview()` →
  `confirmSubmit()`.
- **A test can fail without ever calling the implementation.** The medication acceptance
  test reached for `h.rx` instead of the harness's exported `h.api.rx`, producing a false
  negative at the test boundary. This is the mirror image of the earlier BOM false positive:
  verify that an assertion exercised the intended interface before treating its result as
  implementation evidence.
- **codex-run can appear to hang after a successful run:** Codex keeps a long-lived
  PowerShell AST-parser helper (its command-safety layer) that holds the stdout pipe
  open, so the wrapper's wait never returns even though the work is done and the last
  message is written. Kill the helper child, then the codex PID; the wrapper then writes
  its summary and state normally. Check `.task\evidence\codex-last-*.md` (written by
  Codex itself) before assuming a run is stuck.

## Standing decisions (Kam, 2026-08-19)

- `harness-rescue` Tier 3 contract: **approved**.
- `live_api_sample.json` (client PII, gitignored, desktop only): **keep until the folder
  merge**, then dispose — it never moves into the platform folder.
- Deferred to later contracts: boarding-backend canonical home (platform repo vs
  `Boardingplan` CI); Phase 3 product details; allergy field on the requirements form.

## Rules this programme runs under

- Every source edit goes through the dual-model pipeline (`dual-model-dev` skill).
  Anything touching production n8n, the checkinout contract, or client PII = Tier 3.
- Neither TV URL ever moves; TVs need a manual refresh after any frontend deploy —
  deploy outside feeding windows.
- A failed read is never an empty day; measure before migrating anything healthy
  (HANDOVER §2); a green suite is not a working deploy — exercise the real path.
