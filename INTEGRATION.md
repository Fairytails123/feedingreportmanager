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
| 3 Symbiosis | Plans + medication chips on tablet tiles; plan-vs-report flag in Telegram summary | ⬜ product details to confirm with Kam at contract time |
| 4 Measured infra | Instrument checkinout/plans feeds 2 weeks → move to n8n ONLY on measured degradation; token rework | ⬜ conditional — may correctly never run |
| Endgame | Merge the OneDrive folders (PII file disposed, memory carried on BOTH machines, redirect stub) | ⬜ after Phase 1 shipped + held |

## Findings worth keeping (from the harness-rescue run)

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
