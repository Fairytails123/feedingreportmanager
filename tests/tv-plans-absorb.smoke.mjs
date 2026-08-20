// Acceptance tests for task `tv-plans-absorb` (Phase 1A; contract: .task/contract.md).
// Plain node, no framework: report() accumulator, exit code = failure count.
// Authored BEFORE implementation (tests-first) — must fail on the bare branch.
//
// Env: FTBOARD_SKIP_SPAWN=1 loudly skips checks that spawn bash/PowerShell (the
// Codex sandbox denies nested spawns). A skip is never a pass; the operator runs
// the full suite outside the sandbox before the gate counts.
//
// OPERATOR-owned: the contract forbids the implementer from editing this file.

import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const seedDir = join(repoRoot, '.task', 'seed');
const skipSpawn = process.env.FTBOARD_SKIP_SPAWN === '1';

const PROTECTED = ['index.html', 'display/display.html', 'shared/contract.js',
  'feeding_report_backend_v2.js', 'n8n_workflow_v2_corrected.json'];
const MANIFEST = ['fixture', 'two', 'photo', 'eighteen', 'twenty', 'lists',
  'select_back', 'ok_toggle', 'no_rotate', 'empty', 'arrivals_only',
  'fail_nocache', 'fail_cache', 'backend_stale', 'overlap', 'xss',
  'bad_payload', 'hang_cache', 'worst_case', 'midnight'];
const FIXTURES = ['api_sample.synthetic.json', 'expected_scenarios.json',
  'selftest_bad.json', 'selftest_generic.json', 'selftest_good.json', 'selftest_ignore.json'];
// The five pre-existing suites, in their required order (contract: protected behaviour).
const RUNSH_ORDER = ['node --check feeding_report_backend_v2.js', 'node scripts/check_contract.js',
  'node tests/backend.test.js', 'node tests/tablet.test.js', 'node tests/display.test.js'];

let failures = 0, checks = 0;
function report(name, ok, detail) {
  checks++; if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`);
}
function skip(name, why) { console.log(`SKIP  ${name}  -- ${why} (NOT a pass)`); }
function readText(p) { try { return readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; } }
function sha(p) { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } }
function git(args) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
// The git BLOB is the durable reference, not `.task/seed/`. The seed only exists
// while the originating task is open — it is archived at merge — so a
// seed-dependent test starts failing on every LATER task in this repo. The blob
// is also the authoritative artefact for publishing: the working tree may be
// CRLF under core.autocrlf while the blob (and the live page) are LF.
function gitBlob(pathInRepo) {
  const r = spawnSync('git', ['-C', repoRoot, 'show', `HEAD:${pathInRepo}`],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function shaBuf(b) { return b === null ? null : createHash('sha256').update(b).digest('hex'); }
const lfNorm = b => b === null ? null : Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
// Pinned 2026-08-20: the live fooddata page and its logo. These are the real
// invariants — `tv-plans/` must keep matching what the TV actually serves.
const LIVE_PAGE_SHA = '5d137a9405efdcfde3a80839dee48092252f82ecc8d907ff5b166845202b39d6';
const LIVE_LOGO_SHA = 'a47d3f496f5d3e76e3464a85760e8795d3da5d4f0f3a7351d11dedce93812884';
// Resolve a REAL bash. On Windows a bare `bash` hits the distro-less WSL stub in
// WindowsApps, which dies with "execvpe(/bin/bash) failed" - Git Bash is the one
// that can actually run these scripts.
function resolveBash() {
  if (process.env.FTBOARD_BASH && existsSync(process.env.FTBOARD_BASH)) return process.env.FTBOARD_BASH;
  const candidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'bash'; // non-Windows, or on PATH for real
}
const BASH = resolveBash();
function sh(args, opts) {
  return spawnSync(BASH, args, { encoding: 'utf8', cwd: repoRoot, timeout: 20 * 60 * 1000, ...opts });
}

// ---------------------------------------------------------------- 1
// tv-plans-source-byte-identical
{
  // Against the BLOB and the pinned live-page hashes, not `.task/seed/` — the seed
  // is archived at merge, and the blob is what actually gets published.
  const pageBlob = gitBlob('tv-plans/index.html');
  report('byte-identical: tv-plans/index.html blob matches the live fooddata page',
    shaBuf(pageBlob) === LIVE_PAGE_SHA, `got ${String(shaBuf(pageBlob)).slice(0, 16)}`);
  const logoBlob = gitBlob('tv-plans/assets/img/logo.jpg');
  report('byte-identical: tv-plans/assets/img/logo.jpg blob matches the live logo',
    shaBuf(logoBlob) === LIVE_LOGO_SHA, `got ${String(shaBuf(logoBlob)).slice(0, 16)}`);
  // The working tree may legitimately be CRLF under core.autocrlf; its LF-normalised
  // content must still equal the blob.
  const wtPage = (() => { try { return readFileSync(join(repoRoot, 'tv-plans/index.html')); } catch { return null; } })();
  report('byte-identical: working-tree page LF-normalises to the live page',
    shaBuf(lfNorm(wtPage)) === LIVE_PAGE_SHA, `got ${String(shaBuf(lfNorm(wtPage))).slice(0, 16)}`);
}

// ---------------------------------------------------------------- 2
// protected-surfaces-untouched
{
  const diff = git(['diff', 'main...HEAD', '--name-only']);
  const changed = diff === null ? null : diff.split(/\r?\n/).filter(Boolean);
  report('protected: branch diff readable', changed !== null);
  for (const f of PROTECTED) {
    if (changed !== null) report(`protected: ${f} not changed on branch`, !changed.includes(f));
    const st = git(['status', '--porcelain', '--', f]);
    report(`protected: ${f} no uncommitted change`, st !== null && st.trim() === '', (st || '').trim());
  }
}

// ---------------------------------------------------------------- 3
// harness-moved-intact
{
  const hDir = join(repoRoot, 'tests', 'tv-plans');
  const harness = join(hDir, 'build_and_run.ps1');
  const checker = join(hDir, 'assert_results.ps1');
  report('harness: tests/tv-plans/build_and_run.ps1 exists', existsSync(harness));
  report('harness: tests/tv-plans/assert_results.ps1 exists', existsSync(checker));
  for (const f of FIXTURES) {
    // Each fixture must match its own committed blob (proves nothing drifted since
    // it was reviewed). The seed reference is gone once the task is archived.
    const wt = (() => { try { return readFileSync(join(hDir, 'fixtures', f)); } catch { return null; } })();
    const blob = gitBlob(`tests/tv-plans/fixtures/${f}`);
    report(`harness: fixture ${f} matches its committed blob`,
      wt !== null && blob !== null && shaBuf(lfNorm(wt)) === shaBuf(lfNorm(blob)),
      wt === null ? 'missing' : 'differs from blob');
  }
  const t = readText(harness) || '';
  // Scenario set + per-scenario settings, pinned as the contract's own values rather
  // than compared against a seed that no longer exists after archiving.
  const sigPairs = (t.match(/name\s*=\s*'[a-z_]+';\s*budget\s*=\s*\d+;\s*delay\s*=\s*\d+;\s*shot\s*=\s*\$\w+/g) || []);
  report('harness: every scenario still declares name+budget+delay+shot',
    sigPairs.length === MANIFEST.length, `${sigPairs.length} of ${MANIFEST.length}`);
  const names = [...t.matchAll(/name\s*=\s*'([a-z_]+)'/g)].map(m => m[1]);
  report('harness: exactly the 20 manifest scenarios',
    JSON.stringify([...names].sort()) === JSON.stringify([...MANIFEST].sort()), names.join(','));
  report('harness: targets tv-plans/index.html from its new home',
    /tv-plans/.test(t) && /index\.html/.test(t));
  report('harness: intent comments retained (>=15 scenario comments)',
    (t.match(/^\/\/ /gm) || []).length >= 15);
}

// ---------------------------------------------------------------- 4
// publish-dry-run-byte-identical
{
  const name = 'publish-dry-run-byte-identical';
  const script = join(repoRoot, 'scripts', 'publish_plans_tv.sh');
  report('publish: scripts/publish_plans_tv.sh exists', existsSync(script));
  const src = readText(script) || '';
  report('publish: never pushes on --dry-run (dry-run branch precedes any clone/push)',
    src === '' ? false : (() => {
      const dry = src.search(/dry[-_ ]?run/i), clone = src.search(/git clone/i);
      return dry !== -1 && (clone === -1 || dry < clone);
    })(), 'clone/push must be after the dry-run exit');
  if (skipSpawn) {
    skip(name, 'FTBOARD_SKIP_SPAWN=1');
  } else if (!existsSync(script)) {
    report(name, false, 'script missing');
  } else {
    const r = sh(['scripts/publish_plans_tv.sh', '--dry-run']);
    const out = (r.stdout || '') + (r.stderr || '');
    report('publish: --dry-run exits 0', r.status === 0, `exit=${r.status}; ${out.slice(-250).replace(/\s+/g, ' ')}`);
    report('publish: --dry-run reports the LIVE page SHA-256 (blob, LF)',
      out.toLowerCase().includes(LIVE_PAGE_SHA),
      `expected ${LIVE_PAGE_SHA.slice(0, 16)}... in output`);
    report('publish: --dry-run did not clone fooddata', !/Cloning into/i.test(out));
  }
}

// ---------------------------------------------------------------- 5
// contract-check-catches-token-drift
{
  const name = 'contract-check-catches-token-drift';
  if (skipSpawn) {
    skip(name, 'FTBOARD_SKIP_SPAWN=1');
  } else {
    const r = spawnSync('node', ['scripts/check_contract.js'], { encoding: 'utf8', cwd: repoRoot });
    report('contract-check: exits 0 on the true tree', r.status === 0,
      ((r.stdout || '') + (r.stderr || '')).slice(-250).replace(/\s+/g, ' '));

    // Negative control: a temp tree whose tv-plans API_TOKEN is altered must FAIL.
    const tmp = mkdtempSync(join(tmpdir(), 'tvp-drift-'));
    let built = false;
    try {
      for (const d of ['scripts', 'shared', 'tv-plans', 'display', 'tests']) mkdirSync(join(tmp, d), { recursive: true });
      for (const f of ['scripts/check_contract.js', 'shared/contract.js', 'index.html',
        'display/display.html', 'feeding_report_backend_v2.js', 'tv-plans/index.html']) {
        const s = join(repoRoot, f);
        if (existsSync(s)) copyFileSync(s, join(tmp, f));
      }
      const tvp = join(tmp, 'tv-plans', 'index.html');
      if (existsSync(tvp)) {
        const txt = readFileSync(tvp, 'utf8').replace(/ft-k9-board-2024-sec/g, 'ft-k9-board-DRIFTED');
        writeFileSync(tvp, txt);
        built = true;
      }
    } catch { built = false; }
    if (!built) {
      report('contract-check: negative control buildable', false, 'could not build the drifted tree');
    } else {
      const d = spawnSync('node', [join(tmp, 'scripts', 'check_contract.js')], { encoding: 'utf8', cwd: tmp });
      const dout = (d.stdout || '') + (d.stderr || '');
      report('contract-check: FAILS on a drifted tv-plans token', d.status !== 0, `exit=${d.status}`);
      report('contract-check: names both sides in the failure', /tv-plans/i.test(dout) &&
        /(CHECKINOUT_TOKEN|feeding_report_backend)/i.test(dout), dout.slice(-250).replace(/\s+/g, ' '));
    }
  }
}

// ---------------------------------------------------------------- 6
// full-suite-green-and-ordered
{
  const runsh = readText(join(repoRoot, 'tests', 'run.sh')) || '';
  let lastIdx = -1, ordered = runsh !== '';
  for (const step of RUNSH_ORDER) {
    const i = runsh.indexOf(step);
    if (i === -1 || i < lastIdx) { ordered = false; break; }
    lastIdx = i;
  }
  report('run.sh: all five pre-existing suites present and in original order', ordered);
  report('run.sh: gained a tv-plans step', /tv-plans/.test(runsh));
  report('run.sh: the tv-plans step degrades to a skip, never a hard fail on a non-Windows box',
    /tv-plans/.test(runsh) && /(command -v powershell|SKIP|skip)/i.test(runsh));

  if (skipSpawn) {
    skip('full-suite-green', 'FTBOARD_SKIP_SPAWN=1');
  } else {
    const r = sh(['tests/run.sh']);
    const out = (r.stdout || '') + (r.stderr || '');
    report('run.sh: exits 0', r.status === 0, `exit=${r.status}; ${out.slice(-300).replace(/\s+/g, ' ')}`);
    report('run.sh: reports all suites passed', /ALL SUITES PASSED/.test(out));
    // R-7: a skipped step must never read as a pass. On this (Chrome-equipped) box the
    // tv-plans suite must demonstrably RUN — banner present, skip line absent. Without
    // this, a broken harness would be reported as "Chrome unavailable" and skipped
    // silently inside the pre-deploy gate.
    report('run.sh: the tv-plans suite actually RAN (banner present)',
      /TV feeding plans \(20 scenarios\)/.test(out), out.slice(-300).replace(/\s+/g, ' '));
    report('run.sh: did NOT report the Chrome-unavailable skip on a Chrome-equipped box',
      !/Chrome is unavailable/i.test(out));
    report('run.sh: did NOT report the PowerShell-unavailable skip on Windows',
      !/powershell\.exe is unavailable/i.test(out));
  }
}

console.log(`\n${checks} checks, ${failures} failure(s)${skipSpawn ? ' [SPAWN TESTS SKIPPED - not a full pass]' : ''}`);
process.exit(Math.min(failures, 250));
