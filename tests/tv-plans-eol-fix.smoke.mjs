// Acceptance tests for task `tv-plans-eol-fix` (contract: .task/contract.md).
// Plain node, no framework: report() accumulator, exit code = failure count.
// Authored BEFORE implementation (tests-first) — must fail on the bare branch.
//
// The defect: publish_plans_tv.sh staged the WORKING TREE copy of
// tv-plans/index.html, which core.autocrlf=true checks out as CRLF, so a real
// publish would rewrite every line ending in the public fooddata repo. The git
// BLOB is the correct, LF, byte-identical-to-live artefact — that is the thing
// that must be published.
//
// Env: FTBOARD_SKIP_SPAWN=1 loudly skips the bash-spawning checks (Codex sandbox).
// OPERATOR-owned: the implementer must not edit this file.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const skipSpawn = process.env.FTBOARD_SKIP_SPAWN === '1';

// The live fooddata page, measured 2026-08-20. This is the invariant the whole
// task exists to protect.
const CANONICAL_PAGE_SHA = '72fe2b80389d10bd78732d7df5fe700181b3e51637adc46ad645416d8c806cee';
const CANONICAL_PAGE_BYTES = 90277;

let failures = 0, checks = 0;
function report(name, ok, detail) {
  checks++; if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`);
}
function skip(name, why) { console.log(`SKIP  ${name}  -- ${why} (NOT a pass)`); }
function shaBuf(b) { return createHash('sha256').update(b).digest('hex'); }
function gitBlob(pathInRepo) {
  const r = spawnSync('git', ['-C', repoRoot, 'show', `HEAD:${pathInRepo}`],
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

// The blob is the ground truth for every check below.
const pageBlob = gitBlob('tv-plans/index.html');
const logoBlob = gitBlob('tv-plans/assets/img/logo.jpg');

// ---------------------------------------------------------------- baseline
{
  report('baseline: page blob readable', pageBlob !== null);
  if (pageBlob) {
    report('baseline: page blob still byte-identical to the live fooddata page',
      shaBuf(pageBlob) === CANONICAL_PAGE_SHA && pageBlob.length === CANONICAL_PAGE_BYTES,
      `sha=${shaBuf(pageBlob).slice(0, 16)} bytes=${pageBlob.length}`);
  }
  report('baseline: logo blob readable', logoBlob !== null);
}

// ---------------------------------------------------------------- 3
// gitattributes-pins-eol
{
  const ga = existsSync(join(repoRoot, '.gitattributes'))
    ? readFileSync(join(repoRoot, '.gitattributes'), 'utf8') : null;
  report('gitattributes: file exists', ga !== null);
  if (ga !== null) {
    report('gitattributes: pins tv-plans/index.html to LF',
      /tv-plans\/index\.html\s+.*eol=lf/.test(ga), ga.slice(0, 200).replace(/\s+/g, ' '));
    report('gitattributes: marks the logo binary',
      /tv-plans\/assets\/img\/logo\.jpg\s+binary/.test(ga));
    report('gitattributes: no blanket repo-wide text rule (other surfaces out of scope)',
      !/^\s*\*\s+text/m.test(ga));
  }
}

// ---------------------------------------------------------------- 1, 2, 4, 5
// staged-payload-matches-blob / staged-payload-is-lf / logo-staged-verbatim / protected
{
  const script = join(repoRoot, 'scripts', 'publish_plans_tv.sh');
  const src = existsSync(script) ? readFileSync(script, 'utf8') : '';
  report('publish: script still exists', src !== '');
  report('publish: stages the page LF-normalised (not a raw cp of the working tree)',
    /\\r\\n/.test(src) || /\r\\n/.test(src) || /tr -d/.test(src) || /sed .*\\r/.test(src),
    'expected an explicit CRLF->LF normalisation step');
  report('publish: logo is still a raw byte copy (never text-processed)',
    /cp\s+.*logo\.jpg/.test(src));

  if (skipSpawn) {
    skip('staged-payload-matches-blob', 'FTBOARD_SKIP_SPAWN=1');
    skip('staged-payload-is-lf', 'FTBOARD_SKIP_SPAWN=1');
    skip('logo-staged-verbatim', 'FTBOARD_SKIP_SPAWN=1');
    skip('protected-behaviour-holds', 'FTBOARD_SKIP_SPAWN=1');
  } else if (src === '') {
    report('staged-payload-matches-blob', false, 'script missing');
  } else {
    const r = spawnSync(BASH, ['scripts/publish_plans_tv.sh', '--dry-run'],
      { encoding: 'utf8', cwd: repoRoot, timeout: 5 * 60 * 1000 });
    const out = (r.stdout || '') + (r.stderr || '');
    report('publish: --dry-run exits 0', r.status === 0, `exit=${r.status}; ${out.slice(-250).replace(/\s+/g, ' ')}`);

    // Criterion 1: the SHA the dry-run prints must equal the blob's (== live page).
    report('staged-payload-matches-blob: dry-run SHA equals the git blob / live page',
      out.toLowerCase().includes(CANONICAL_PAGE_SHA),
      `expected ${CANONICAL_PAGE_SHA.slice(0, 16)}... in: ${out.replace(/\s+/g, ' ').slice(-300)}`);

    // Criteria 2 + 4: inspect the retained staged payload itself.
    const m = out.match(/Staged payload[^:]*:\s*(\S+)/);
    // Git Bash reports an MSYS path (/tmp/...) that Node on Windows cannot open —
    // translate it back with cygpath.
    let dir = m ? m[1] : null;
    if (dir && dir.startsWith('/')) {
      const c = spawnSync(BASH, ['-lc', `cygpath -w '${dir}'`], { encoding: 'utf8' });
      if (c.status === 0 && c.stdout.trim()) dir = c.stdout.trim();
    }
    report('publish: dry-run reports a retained staged payload path', dir !== null);
    if (dir) {
      const stagedPage = join(dir, 'index.html');
      const stagedLogo = join(dir, 'assets', 'img', 'logo.jpg');
      if (existsSync(stagedPage)) {
        const buf = readFileSync(stagedPage);
        report('staged-payload-is-lf: zero CRLF pairs', !buf.includes(Buffer.from('\r\n')));
        report('staged-payload-is-lf: byte count matches the blob', buf.length === CANONICAL_PAGE_BYTES,
          `${buf.length} vs ${CANONICAL_PAGE_BYTES}`);
        report('staged-payload-matches-blob: staged bytes hash to the live page',
          shaBuf(buf) === CANONICAL_PAGE_SHA, shaBuf(buf).slice(0, 16));
      } else {
        report('staged-payload-is-lf: staged page present for inspection', false, stagedPage);
      }
      if (existsSync(stagedLogo) && logoBlob) {
        report('logo-staged-verbatim: staged logo equals the blob byte-for-byte',
          shaBuf(readFileSync(stagedLogo)) === shaBuf(logoBlob));
      } else {
        report('logo-staged-verbatim: staged logo present', false, stagedLogo);
      }
    }

    // Criterion 5: protected behaviour.
    report('protected-behaviour-holds: dry-run ran the contract check first',
      /contract drift-check/i.test(out));
    report('protected-behaviour-holds: dry-run never cloned', !/Cloning into/i.test(out));
  }
}

console.log(`\n${checks} checks, ${failures} failure(s)${skipSpawn ? ' [SPAWN TESTS SKIPPED - not a full pass]' : ''}`);
process.exit(Math.min(failures, 250));
