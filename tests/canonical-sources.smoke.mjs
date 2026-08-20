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
// The sibling repo becomes a publish target; it still exists on disk until the
// folder-merge endgame. NOTE: this suite runs BOTH from the real repo
// (…\CODING\Feeding manager_Telegram) and from a worktree
// (…\CODING\_worktrees\<repo>--<task>), which sits one level deeper — so probe
// both candidates rather than assuming a fixed depth.
const sibling = (() => {
  for (const c of [
    resolve(repoRoot, '..', 'Dog feed requirement display'),
    resolve(repoRoot, '..', '..', 'Dog feed requirement display'),
  ]) if (existsSync(c)) return c;
  return resolve(repoRoot, '..', 'Dog feed requirement display'); // report a clear miss
})();

// Pinned 2026-08-20. The TV page the kennel display actually serves.
// CANONICAL = the repo's maintained TV page (the source of truth).
const CANONICAL_PAGE_SHA = '72fe2b80389d10bd78732d7df5fe700181b3e51637adc46ad645416d8c806cee';
// PUBLISHED = what https://fairytails123.github.io/fooddata/ actually serves right now.
// These are equal ONLY when there is nothing waiting to be published. Re-pin this after
// each publish; do not "fix" a mismatch by copying the canonical hash over it.
const PUBLISHED_PAGE_SHA = '5d137a9405efdcfde3a80839dee48092252f82ecc8d907ff5b166845202b39d6';
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
  const published = join(sibling, 'index.html');
  report('publish artefact: sibling index.html still present (Pages serves it)',
    existsSync(published));
  report('publish artefact: it matches the pinned PUBLISHED page',
    shaFileLF(published) === PUBLISHED_PAGE_SHA, `got ${String(shaFileLF(published)).slice(0, 16)}`);
  // Not a failure — a visible statement of fact, so nobody has to guess whether the TV
  // is current. Re-pin PUBLISHED_PAGE_SHA to the canonical hash after publishing.
  const pending = shaFileLF(canonical) !== shaFileLF(published);
  console.log(pending
    ? 'NOTE  UNPUBLISHED CHANGES PENDING: the TV page source has moved ahead of what fooddata serves.\n' +
      `      canonical=${String(shaFileLF(canonical)).slice(0, 16)}  published=${String(shaFileLF(published)).slice(0, 16)}\n` +
      '      Publish with: bash scripts/publish_plans_tv.sh "msg"  (then refresh the TV browser)'
    : 'NOTE  The TV page source and the published page are identical — the TV is current.');

  // No THIRD copy anywhere: scan both repos for any other file that looks like the TV page.
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
      else if (e.name.endsWith('.html') && isTvPage(join(root, r))) found.push(`${basename(root)}/${r}`);
    }
  };
  walk(repoRoot); walk(sibling);
  const expected = ['Feeding manager_Telegram/tv-plans/index.html',
    'Dog feed requirement display/index.html'];
  report('canonical: exactly TWO TV-page files exist (1 source + 1 publish artefact)',
    found.length === 2 && expected.every(e => found.some(f => f.endsWith(e.split('/').slice(-2).join('/')))),
    `found: ${found.join(', ') || 'none'}`);
}

// ---------------------------------------------------------------- 2
// harness-deduplicated
{
  report('dedup: sibling repo has NO tests/ directory', !existsSync(join(sibling, 'tests')),
    'the duplicated harness must be gone');
  const tracked = git(sibling, ['ls-files']);
  report('dedup: sibling repo tracks no tests/ files',
    tracked !== null && !tracked.split(/\r?\n/).some(f => f.startsWith('tests/')));

  // The platform copy must be INTACT — deduplication must not have removed the survivor.
  const hDir = join(repoRoot, 'tests', 'tv-plans');
  report('dedup: platform harness intact (build_and_run.ps1)', existsSync(join(hDir, 'build_and_run.ps1')));
  report('dedup: platform checker intact (assert_results.ps1)', existsSync(join(hDir, 'assert_results.ps1')));
  for (const f of HARNESS_FIXTURES) {
    report(`dedup: platform fixture ${f} intact`, existsSync(join(hDir, 'fixtures', f)));
  }
}

// ---------------------------------------------------------------- 3
// sibling-is-publish-target-only
{
  for (const doc of ['CLAUDE.md', 'HANDOVER.md']) {
    const t = readText(join(sibling, doc));
    report(`stub: sibling ${doc} exists`, t !== null);
    if (t !== null) {
      report(`stub: ${doc} says the repo is a publish target`, /publish target/i.test(t));
      report(`stub: ${doc} names the canonical source location`, /tv-plans/i.test(t));
      report(`stub: ${doc} names the publish command`, /publish_plans_tv\.sh/.test(t));
      report(`stub: ${doc} is short (a stub, not a second manual)`, t.length < 4000, `${t.length} chars`);
      // It must NOT still tell people to run a harness here or edit the page here.
      report(`stub: ${doc} no longer points at a local tests\\ harness`,
        !/tests[\\/]build_and_run\.ps1/.test(t));
    }
  }
}

// ---------------------------------------------------------------- 4
// no-competing-boarding-copy
{
  report('boarding: the sibling local mirror is gone',
    !existsSync(join(sibling, 'supersetplanner&feed.gs')));
  // And no copy has been smuggled into the platform repo.
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
  // Client PII stays exactly where Kam decided it stays.
  const pii = join(sibling, 'live_api_sample.json');
  report('protected: live_api_sample.json still present in the sibling repo', existsSync(pii));
  const ignored = spawnSync('git', ['-C', sibling, 'check-ignore', '-q', 'live_api_sample.json']);
  report('protected: live_api_sample.json still gitignored', ignored.status === 0);

  // The sibling publish artefact and its logo are untouched.
  const sibTracked = git(sibling, ['status', '--porcelain', '--', 'index.html', 'assets']);
  report('protected: sibling index.html + assets have no uncommitted change',
    sibTracked !== null && sibTracked.trim() === '', (sibTracked || '').trim());

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
