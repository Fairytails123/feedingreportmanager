// Acceptance tests for task `canonical-sources` (contract: .task/contract.md).
// R1: exactly ONE maintained copy of the TV page. R2: the LIVE Apps Script is the
// only source of truth for the boarding script, with a drift-proof protocol.
// Plain node, no framework: report() accumulator, exit code = failure count.
// Authored BEFORE implementation (tests-first) — must fail on the bare branch.
//
// Env: FTBOARD_SKIP_SPAWN=1 loudly skips bash-spawning checks (Codex sandbox).
// OPERATOR-owned: the implementer must not edit this file.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
// FOLDER MERGE, 2026-08-21: the sibling folder `CODING\Dog feed requirement display`
// is GONE. It was only ever a local clone of the `fooddata` publish target, and the
// publisher clones fooddata fresh into a temp dir every time, so nothing needed it.
//
// The published page is now verified against what GitHub ACTUALLY SERVES, which is
// strictly better than reading a local clone: a local clone goes stale the moment
// publish_plans_tv.sh pushes via its temp clone (that bit us on 2026-08-20 — the check
// failed against a stale working copy rather than against Pages).
const PUBLISHED_URL = 'https://raw.githubusercontent.com/Fairytails123/fooddata/main/index.html';
const sibling = null; // retired; kept as an explicit null so any stray use fails loudly

// Pinned 2026-08-20. The TV page the kennel display actually serves.
// CANONICAL = the repo's maintained TV page (the source of truth).
const CANONICAL_PAGE_SHA = '72fe2b80389d10bd78732d7df5fe700181b3e51637adc46ad645416d8c806cee';
// PUBLISHED = what https://fairytails123.github.io/fooddata/ actually serves right now.
// These are equal ONLY when there is nothing waiting to be published. Re-pin this after
// each publish; do not "fix" a mismatch by copying the canonical hash over it.
const PUBLISHED_PAGE_SHA = '72fe2b80389d10bd78732d7df5fe700181b3e51637adc46ad645416d8c806cee';
// Pinned 2026-08-20, EOL-normalised. The live Apps Script == Boardingplan == old mirror.
const LIVE_GAS_SHA = 'd5cc2ff8a61a8fdbf5ad73a974448c810b7d3a6b34f38b17756aadee64c11cb8';
const HARNESS_FIXTURES = ['api_sample.synthetic.json', 'expected_scenarios.json',
  'selftest_bad.json', 'selftest_generic.json', 'selftest_good.json', 'selftest_ignore.json'];

let failures = 0, checks = 0;
function report(name, ok, detail) {
  checks++; if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`);
}
function skip(name, why) { console.log(`SKIP  ${name}  -- ${why} (NOT a pass)`); }
function readText(p) { try { return readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; } }
function shaBuf(b) { return b === null ? null : createHash('sha256').update(b).digest('hex'); }
function shaFile(p) { try { return shaBuf(readFileSync(p)); } catch { return null; } }
const lfNorm = b => b === null ? null : Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
function shaFileLF(p) { try { return shaBuf(lfNorm(readFileSync(p))); } catch { return null; } }
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
function gitBlob(repo, p) {
  const r = spawnSync('git', ['-C', repo, 'show', `HEAD:${p}`],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function resolveBash() {
  if (process.env.FTBOARD_BASH && existsSync(process.env.FTBOARD_BASH)) return process.env.FTBOARD_BASH;
  for (const c of [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]) if (existsSync(c)) return c;
  return 'bash';
}
const BASH = resolveBash();
const skipSpawn = process.env.FTBOARD_SKIP_SPAWN === '1';

// ---------------------------------------------------------------- 1
// one-canonical-tv-page
{
  const canonical = join(repoRoot, 'tv-plans', 'index.html');
  report('canonical: tv-plans/index.html matches the pinned canonical source',
    shaFileLF(canonical) === CANONICAL_PAGE_SHA, `got ${String(shaFileLF(canonical)).slice(0, 16)}`);
  report('canonical: its committed blob matches the working tree',
    shaBuf(lfNorm(gitBlob(repoRoot, 'tv-plans/index.html'))) === CANONICAL_PAGE_SHA);

  // CANONICAL (the repo's source) and PUBLISHED (what Pages actually serves) are two
  // DIFFERENT facts, and conflating them hides the one that matters operationally:
  // whether the TV is showing the current design. They diverge legitimately whenever the
  // source has moved ahead of the last publish — which is the state right now, because
  // the prescription-medication red styling has not been published yet.
  // Fetch what GitHub actually serves. Network-dependent, so a failure to reach it is a
  // LOUD skip rather than a false red — but a reachable-and-different page IS a failure.
  const fetched = spawnSync('curl', ['-sS', '--max-time', '45', PUBLISHED_URL], { encoding: 'buffer' });
  if (fetched.status !== 0 || !fetched.stdout || fetched.stdout.length === 0) {
    skip('publish artefact: matches the pinned PUBLISHED page', 'could not reach GitHub (offline?)');
  } else {
    const publishedSha = shaBuf(lfNorm(fetched.stdout));
    report('publish artefact: what fooddata serves matches the pinned PUBLISHED page',
      publishedSha === PUBLISHED_PAGE_SHA, `got ${String(publishedSha).slice(0, 16)}`);
    // Not a failure — a visible statement of fact, so nobody has to guess whether the TV
    // is current. Re-pin PUBLISHED_PAGE_SHA only AFTER publishing.
    console.log(shaFileLF(canonical) !== publishedSha
      ? 'NOTE  UNPUBLISHED CHANGES PENDING: the TV page source has moved ahead of what fooddata serves.\n' +
        `      canonical=${String(shaFileLF(canonical)).slice(0, 16)}  published=${String(publishedSha).slice(0, 16)}\n` +
        '      Publish with: bash scripts/publish_plans_tv.sh "msg"  (then refresh the TV browser)'
      : 'NOTE  The TV page source and the published page are identical — the TV is current.');
  }

  // No SECOND copy anywhere in this repo. (Before the 2026-08-21 folder merge this also
  // scanned the sibling clone; that folder is gone, and its absence is asserted below.)
  const isTvPage = p => {
    const t = readText(p);
    return t !== null && t.includes('Boarding Feeding Board') && t.includes('API_TOKEN');
  };
  const found = [];
  const walk = (root, rel = '') => {
    let entries; try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['.git', 'node_modules', '.task', '.gate-evidence', '_worktrees'].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(root, r);
      else if (e.name.endsWith('.html') && isTvPage(join(root, r))) found.push(r);
    }
  };
  walk(repoRoot);
  report('canonical: exactly ONE TV-page file exists in this repo',
    found.length === 1 && found[0] === 'tv-plans/index.html',
    `found: ${found.join(', ') || 'none'}`);
}

// ---------------------------------------------------------------- 1b
// folder-merge-is-complete (2026-08-21) — this must never silently regress
{
  const retired = [
    resolve(repoRoot, '..', 'Dog feed requirement display'),
    resolve(repoRoot, '..', '..', 'Dog feed requirement display'),
  ];
  const stillThere = retired.filter(p => existsSync(p));
  report('folder merge: the retired Dog-feed-requirement-display folder is gone',
    stillThere.length === 0, stillThere.join(', '));
  // Its only local-only files were the PII capture and a settings file. The PII was
  // disposed of at the merge (Kam's standing decision); if a copy ever reappears anywhere
  // under CODING, that is a client-data problem, not an untidiness problem.
  for (const p of retired) {
    report(`folder merge: no live_api_sample.json at ${basename(dirname(p))}/${basename(p)}`,
      !existsSync(join(p, 'live_api_sample.json')));
  }
}

// ---------------------------------------------------------------- 2
// harness-deduplicated
{
  // The duplicated harness lived in the sibling folder, which no longer exists (asserted
  // in 1b above). What remains to guard is that the SURVIVOR here is intact — a
  // deduplication that removes the wrong copy is the real risk.
  const hDir = join(repoRoot, 'tests', 'tv-plans');
  report('dedup: platform harness intact (build_and_run.ps1)', existsSync(join(hDir, 'build_and_run.ps1')));
  report('dedup: platform checker intact (assert_results.ps1)', existsSync(join(hDir, 'assert_results.ps1')));
  for (const f of HARNESS_FIXTURES) {
    report(`dedup: platform fixture ${f} intact`, existsSync(join(hDir, 'fixtures', f)));
  }
}

// ---------------------------------------------------------------- 3
// fooddata-is-publish-target-only
// The redirect stubs live in the fooddata REPO (verified there at the 2026-08-20
// consolidation, commit 34fd274) — there is no longer a local clone to read them from,
// and re-fetching two docs over the network on every gate run would buy little. The
// property that actually matters — that this repo holds the ONE maintained page and the
// live page matches it — is asserted in block 1 against what GitHub serves.
{
  const claudeMd = readText(join(repoRoot, 'CLAUDE.md')) || '';
  report('publish target: CLAUDE.md states fooddata is a publish target only',
    /fooddata/i.test(claudeMd) && /publish target/i.test(claudeMd));
  report('publish target: CLAUDE.md names the publish command',
    /publish_plans_tv\.sh/.test(claudeMd));
}

// ---------------------------------------------------------------- 4
// no-competing-boarding-copy
{
  // The sibling local mirror went with the folder (asserted in 1b). What must keep holding
  // is that no boarding-script copy has been smuggled into THIS repo — the live Apps Script
  // and Boardingplan are the only two places it may exist.
  const found = [];
  const walk = (root, rel = '') => {
    let entries; try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['.git', 'node_modules', '.task', '.gate-evidence'].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(root, r);
      else if (/\.gs$/i.test(e.name)) found.push(r);
      else if (/\.js$/i.test(e.name)) {
        const t = readText(join(root, r));
        // The boarding script's distinctive internals — not the feeding backend's.
        if (t && t.includes('getFeedingBoardData') && t.includes('acuityDogNameCache')) found.push(r);
      }
    }
  };
  walk(repoRoot);
  report('boarding: no boarding-script copy exists in the platform repo', found.length === 0,
    `found: ${found.join(', ')}`);
}

// ---------------------------------------------------------------- 5
// drift-checker-is-safe
{
  const p = join(repoRoot, 'scripts', 'check_boarding_drift.sh');
  const t = readText(p);
  report('drift: scripts/check_boarding_drift.sh exists', t !== null);
  if (t !== null) {
    report('drift: clones the live script read-only', /clasp\s+clone-script/.test(t));
    report('drift: NEVER writes to Apps Script (no push/redeploy/create-version)',
      !/clasp\s+(push|redeploy|create-version|deploy)\b/.test(t),
      'a write verb would make the checker itself a production risk');
    report('drift: compares against the Boardingplan deploy vehicle', /Boardingplan/i.test(t));
    report('drift: EOL-normalises before comparing (Apps Script strips trailing newline)',
      /\\r/.test(t) || /tr -d/.test(t) || /dos2unix/.test(t));
    report('drift: skips loudly when clasp is absent', /command -v clasp|which clasp/.test(t));
    report('drift: honours BOARDING_STRICT', /BOARDING_STRICT/.test(t));
    report('drift: pins the real script id', /12ZBH5zualFVdVz23pmC7orrqcf6wyUA8YbXKa6kR3kxm4T4KdBubh5gM/.test(t));
  }
}

// ---------------------------------------------------------------- 6
// runsh-optin-step
{
  const t = readText(join(repoRoot, 'tests', 'run.sh')) || '';
  const ORDER = ['node --check feeding_report_backend_v2.js', 'node scripts/check_contract.js',
    'node tests/backend.test.js', 'node tests/tablet.test.js', 'node tests/display.test.js'];
  let last = -1, ordered = t !== '';
  for (const s of ORDER) { const i = t.indexOf(s); if (i === -1 || i < last) { ordered = false; break; } last = i; }
  report('run.sh: pre-existing suites present and in original order', ordered);
  report('run.sh: still runs the TV harness step', /tv-plans/.test(t) && /20 scenarios/.test(t));
  report('run.sh: gained an opt-in BOARDING step', /BOARDING/.test(t) && /check_boarding_drift/.test(t));
}

// ---------------------------------------------------------------- 7
// protected-behaviour-holds
{
  // Client PII: Kam's decision was "keep until the folder merge, then dispose". The merge
  // happened 2026-08-21, so the correct state is now ABSENT — and it must not come back.
  // Replays use tests/tv-plans/fixtures/api_sample.synthetic.json instead.
  const piiFound = [];
  const codingRoot = resolve(repoRoot, '..');
  const scanForPii = (root, rel = '', depth = 0) => {
    if (depth > 3) return;
    let entries; try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['.git', 'node_modules', '_worktrees', '.task'].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) scanForPii(root, r, depth + 1);
      else if (e.name.toLowerCase() === 'live_api_sample.json') piiFound.push(r);
    }
  };
  scanForPii(codingRoot);
  report('protected: the PII capture live_api_sample.json is gone from CODING',
    piiFound.length === 0, piiFound.join(', '));
  report('protected: the synthetic replacement fixture is present',
    existsSync(join(repoRoot, 'tests', 'tv-plans', 'fixtures', 'api_sample.synthetic.json')));

  // REMOVED 2026-08-20: "unchanged on this branch" guards.
  // They were correct scope-control for the canonical-sources TASK, but this suite runs
  // permanently and the gate runs every tests/*.smoke.mjs — so once that task merged, the
  // checks began asserting that NO LATER TASK may ever touch index.html, tv-plans/index.html
  // or check_contract.js. The very next task (prescription-medication warnings) legitimately
  // changes all three, and these turned into three false failures on a correct change.
  // Same family as the .task/seed lesson: a permanent suite may only assert things that stay
  // true after its own task merges. Scope control belongs in the CONTRACT (MUST-NOT lists)
  // and in the blind review, both of which are per-task. The durable properties this suite
  // exists for — one canonical page, harness deduplicated, no competing boarding copy, the
  // drift checker's read-only shape — are all asserted above and are unaffected.

  if (skipSpawn) {
    skip('protected: tests/run.sh exits 0 offline', 'FTBOARD_SKIP_SPAWN=1');
    skip('protected: publish dry-run still byte-exact', 'FTBOARD_SKIP_SPAWN=1');
  } else {
    const r = spawnSync(BASH, ['tests/run.sh'], { encoding: 'utf8', cwd: repoRoot, timeout: 20 * 60 * 1000 });
    const out = (r.stdout || '') + (r.stderr || '');
    report('protected: tests/run.sh exits 0 offline', r.status === 0,
      `exit=${r.status}; ${out.slice(-250).replace(/\s+/g, ' ')}`);
    report('protected: the TV harness actually ran in run.sh', /TV feeding plans \(20 scenarios\)/.test(out));
    report('protected: the boarding step was skipped by default (opt-in)',
      /BOARDING/i.test(out) && !/BOARDING DRIFT CHECK: OK/.test(out));

    const d = spawnSync(BASH, ['scripts/publish_plans_tv.sh', '--dry-run'],
      { encoding: 'utf8', cwd: repoRoot, timeout: 5 * 60 * 1000 });
    const dout = (d.stdout || '') + (d.stderr || '');
    report('protected: publish dry-run still stages the live page byte-exactly',
      d.status === 0 && dout.toLowerCase().includes(CANONICAL_PAGE_SHA),
      `exit=${d.status}`);
  }
}

// ---------------------------------------------------------------- boarding truth
// The live script must be untouched by this task. Verified against the mirror the
// operator captured at 16:13 (all three copies agreed then).
{
  console.log(`NOTE  live Apps Script truth hash (EOL-normalised), pinned 2026-08-20: ${LIVE_GAS_SHA.slice(0, 16)}…`);
  console.log('NOTE  criterion 8 (drift checker run for real) is the operator MANUAL step: BOARDING=1 bash tests/run.sh');
}

console.log(`\n${checks} checks, ${failures} failure(s)${skipSpawn ? ' [SPAWN TESTS SKIPPED - not a full pass]' : ''}`);
process.exit(Math.min(failures, 250));
