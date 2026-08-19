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
| 0 | Harness rescue + synthetic fixture (task `harness-rescue`, **Tier 3** — client PII) | 🔄 IN PIPELINE — contract Kam-approved 2026-08-19; tests-first proven (6 fails on bare repo); Codex critique → implement → gate → blind review → merge (needs Kam `-KamApproved`) |
| 1 Repo unification | Move DFRD page in as `tv-plans/` + publish script to `fooddata`; backend mirror in as `backend-boarding/`; extend `check_contract.js` (token, exec URLs, JotForm maps); carry Claude project memory | ⬜ after Phase 0 |
| 2 Shared modules | `shared/name-match.js` + `shared/fetch-kit.js` (ES5), equivalence-tested, adopted per surface | ⬜ |
| 3 Symbiosis | Plans + medication chips on tablet tiles; plan-vs-report flag in Telegram summary | ⬜ product details to confirm with Kam at contract time |
| 4 Measured infra | Instrument checkinout/plans feeds 2 weeks → move to n8n ONLY on measured degradation; token rework | ⬜ conditional — may correctly never run |
| Endgame | Merge the OneDrive folders (PII file disposed, memory carried on BOTH machines, redirect stub) | ⬜ after Phase 1 shipped + held |

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
