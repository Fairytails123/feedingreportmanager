// Acceptance tests for task `rx-medication-warnings` (contract: .task/contract.md).
//
// The objective: prescription medication must be impossible to overlook during a feed.
// Red tile on BOTH surfaces whenever medication is attached; the tablet additionally
// demands an explicit acknowledgement that never clears the red.
//
// Plain node, no framework: report() accumulator, exit code = failure count.
// Authored BEFORE implementation (tests-first) — must fail on the bare branch.
// Env: FTBOARD_SKIP_SPAWN=1 loudly skips spawn-dependent checks (Codex sandbox).
// OPERATOR-owned: the implementer must not edit this file.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const require = createRequire(import.meta.url);
const skipSpawn = process.env.FTBOARD_SKIP_SPAWN === '1';
const TABLET = join(repoRoot, 'index.html');
const TV = join(repoRoot, 'tv-plans', 'index.html');

let failures = 0, checks = 0;
function report(name, ok, detail) {
  checks++; if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -- ' + detail : ''}`);
}
function skip(name, why) { console.log(`SKIP  ${name}  -- ${why} (NOT a pass)`); }
function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function resolveBash() {
  if (process.env.FTBOARD_BASH && existsSync(process.env.FTBOARD_BASH)) return process.env.FTBOARD_BASH;
  for (const c of [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ]) if (existsSync(c)) return c;
  return 'bash';
}
const BASH = resolveBash();
// Pull one CSS rule body out of an inline <style>. Returns '' when absent.
function cssRule(src, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'i');
  const m = src.match(re);
  return m ? m[1] : '';
}

const tvSrc = readText(TV) || '';
const tabSrc = readText(TABLET) || '';

// ---------------------------------------------------------------- 1
// tv-red-tile-css
{
  const rule = cssRule(tvSrc, '.tcard.has-med');
  report('tv: a .tcard.has-med rule exists', rule !== '',
    'the has-med hook is already emitted at ~line 1440 and had no CSS');
  if (rule !== '') {
    report('tv: it changes the tile surface itself (background)', /background/i.test(rule));
    // box-sizing: border-box means a WIDTH change alters the auto-fit envelope and
    // shrinks --tz for medication cards only. Colour is free; width is not.
    report('tv: it does NOT change any border WIDTH',
      !/border(-[a-z]+)?-width\s*:/i.test(rule) &&
      !/border(-left|-right|-top|-bottom)?\s*:\s*\d/i.test(rule),
      'recolour the existing 10px left border; never resize it');
  }
  // Past 20 dogs applyTodayLayout sets NO gN class, so a gN-scoped rule silently stops.
  report('tv: the red rule is not scoped to a gN layout class',
    !/\.g\d+[^{]*\.has-med|\.has-med[^{]*\.g\d+/i.test(tvSrc));
}

// ---------------------------------------------------------------- 2
// tv-chip-still-distinct
{
  const tile = cssRule(tvSrc, '.tcard.has-med');
  const chip = cssRule(tvSrc, '.med-chip');
  const bgOf = r => { const m = r.match(/background[^:]*:\s*([^;]+)/i); return m ? m[1].trim().toLowerCase() : ''; };
  const tileBg = bgOf(tile), chipBg = bgOf(chip);
  report('tv: the medication chip does not vanish into the red tile',
    tile === '' ? false : (chipBg !== '' && tileBg !== '' && chipBg !== tileBg),
    `tile=${tileBg || '(none)'} chip=${chipBg || '(none)'} — the chip must stay distinct`);
}

// ---------------------------------------------------------------- 3
// tv-has-med-emitted-and-harness-green
{
  report('tv: has-med is emitted from the medication condition',
    /has-med/.test(tvSrc) && /medication\s*===\s*'Yes'/.test(tvSrc));
  if (skipSpawn) {
    skip('tv: 20-scenario harness still green', 'FTBOARD_SKIP_SPAWN=1');
  } else {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests\\tv-plans\\build_and_run.ps1'],
      { encoding: 'utf8', cwd: repoRoot, timeout: 20 * 60 * 1000 });
    report('tv: 20-scenario harness still exits 0 (no regression to normal cards)',
      r.status === 0, `exit=${r.status}`);
  }
}

// ---------------------------------------------------------------- 5
// portion-channel-intact  (checked before the behavioural block so it runs even if load fails)
{
  const rule = cssRule(tabSrc, '.pen-dog.has-rx');
  report('tablet: a .pen-dog.has-rx rule exists', rule !== '');
  if (rule !== '') {
    report('tablet: the red rule never touches border-left-color (the portion channel)',
      !/border-left-color/i.test(rule) && !/border-left\s*:/i.test(rule),
      'portion colour lives on the left edge and must keep working');
  }
  for (const s of ['status-all', 'status-three-quarter', 'status-half', 'status-quarter', 'status-none']) {
    report(`tablet: portion rule .pen-dog.${s} still present`, cssRule(tabSrc, `.pen-dog.${s}`) !== '');
  }
  report('tablet: a danger token was added (the Organic palette had no red)',
    /--color-danger/.test(tabSrc));
}

// ---------------------------------------------------------------- 6
// staging-tiles-red
{
  report('tablet: staging .dog-card also goes red for a prescription dog',
    cssRule(tabSrc, '.dog-card.has-rx') !== '',
    'a prescription dog in staging is currently unflagged entirely');
}

// ---------------------------------------------------------------- static: ack + submit shape
{
  report('tablet: the acknowledgement store key follows the house convention',
    /feedingManager\.rxAck\.v1/.test(tabSrc));
  // Must be a REAL acknowledgement path: a confirm() whose text names prescription
  // medication AND states the "I have checked it" confirmation. Merely containing the
  // word "prescription" somewhere is not evidence (the file already has prescription
  // fields), so require both in proximity to a confirm call.
  report('tablet: the warning is a blocking confirm() that states the acknowledgement',
    /confirm\s*\([^)]{0,400}prescription medication/i.test(tabSrc) ||
    /rxWarn|rxConfirm|confirmRx/i.test(tabSrc) && /have checked/i.test(tabSrc),
    'expected a confirm() naming PRESCRIPTION MEDICATION and the "checked it" confirmation');
  // The ack must NOT be a dog field: applyRemoteState rebuilds dogs from an explicit
  // whitelist, so a field there is silently dropped within ~5s.
  const whitelistZone = tabSrc.slice(Math.max(0, tabSrc.indexOf('possibleMatches: m.possibleMatches') - 400),
                                     tabSrc.indexOf('possibleMatches: m.possibleMatches') + 800);
  report('tablet: the ack flag is NOT carried on the dog object',
    whitelistZone !== '' && !/rxAck|acknowledg/i.test(whitelistZone),
    'applyRemoteState would wipe it within ~5s');
  report('tablet: the submit gate is unchanged (isOnline && empty queue)',
    /isOnline/.test(tabSrc) && /mutationQueue\.length\s*===\s*0|queue.*empty/i.test(tabSrc));
}

// ---------------------------------------------------------------- behavioural (harness)
{
  let h = null, loadErr = null;
  try { h = require('./tablet_harness').load(TABLET); } catch (e) { loadErr = e; }
  report('tablet: harness loads the real inline script', h !== null, loadErr ? String(loadErr).slice(0, 200) : '');

  if (h && h.rx && h.rx.present) {
    const PLAN = {
      dogs: [
        { dogName: 'Bolt', ownerSurname: 'Quixling', matched: true,
          feeding: { medication: 'Yes', medicationDetails: 'Fabuprofen 1 tablet with food', specialNotes: '' } },
        { dogName: 'Luna', ownerSurname: 'Snorkelby', matched: true,
          feeding: { medication: 'No', medicationDetails: '', specialNotes: '' } },
        // Two dogs share a surname -> a surname-only match must be refused as ambiguous.
        { dogName: 'Comet', ownerSurname: 'Vexworth', matched: true,
          feeding: { medication: 'Yes', medicationDetails: 'Eye drops twice daily', specialNotes: '' } },
        { dogName: 'Fig', ownerSurname: 'Vexworth', matched: true,
          feeding: { medication: 'No', medicationDetails: '', specialNotes: '' } },
      ],
    };
    try { h.rx.planState = { ok: true, dogs: PLAN.dogs, fetchedAt: Date.now() }; } catch {}

    const mk = (name, presc) => ({ id: 'd-' + name, inputName: name, matchedName: name,
      possibleMatches: [], status: 'all', prescription: !!presc, prescriptionComment: '',
      supplements: false, supplementTypes: [], position: 0 });

    // 4 — red is the union of plan-declared and staff-flagged
    const planOnly = mk('Bolt Quixling', false);
    const staffOnly = mk('Zephyr Testerly', true);
    const both = mk('Comet Vexworth', true);
    const neither = mk('Luna Snorkelby', false);
    report('tablet-union: plan-declared medication reads red', h.rx.needs(planOnly) === true);
    report('tablet-union: staff-flagged prescription reads red', h.rx.needs(staffOnly) === true);
    report('tablet-union: both reads red', h.rx.needs(both) === true);
    report('tablet-union: neither does not read red', h.rx.needs(neither) === false);

    // 10 — the join must use the backend's normalisation and refuse ambiguity
    if (typeof h.rx.normName('X') !== 'undefined') {
      report('join: normalisation folds case, spacing and curly apostrophes',
        h.rx.normName("  O’Malley   Reed ") === h.rx.normName("o'malley reed"));
    } else {
      report('join: normalisation helper exists', false);
    }
    report('join: an ambiguous surname-only match is NOT applied',
      h.rx.needs(mk('Vexworth', false)) === false,
      'two plan dogs share Vexworth — matching on surname alone would be a guess');

    // 7/8 — acknowledgement semantics
    try { h.setMealType('Lunch'); } catch {}
    const key = h.rx.ackKey(planOnly);
    report('ack: the key is scoped to dog + date + meal',
      typeof key === 'string' && key.includes(planOnly.id) && /\d{4}-\d{2}-\d{2}/.test(key) && /Lunch/.test(key),
      `key=${key}`);
    report('ack: not acknowledged initially', h.rx.isAcked(planOnly) === false);
    h.rx.markAcked(planOnly);
    report('ack: acknowledging is recorded', h.rx.isAcked(planOnly) === true);
    report('ack: acknowledging does NOT clear the red', h.rx.needs(planOnly) === true);
    // The poll rebuilds dogs from a whitelist; the ack must survive it.
    try {
      h.setDogs([planOnly]);
      h.callApplyRemoteState({ success: true, dogs: [{
        dogId: planOnly.id, inputName: planOnly.inputName, matchedName: planOnly.matchedName,
        status: 'all', prescription: false, prescriptionComment: '', supplements: false,
        supplementTypes: [], penId: 'top-1', position: 1000 }], mealType: 'Lunch', version: 2, count: 1 });
      report('ack: survives an applyRemoteState poll', h.rx.isAcked(planOnly) === true);
    } catch (e) {
      report('ack: survives an applyRemoteState poll', false, String(e).slice(0, 160));
    }

    // 9 — a failed plan read is never "no dog needs medication"
    try {
      h.rx.planState = { ok: false, error: 'fetch failed', dogs: [] };
      const r = h.rx.needs(mk('Bolt Quixling', false));
      report('failure: an unreadable plan does NOT report "no medication" as fact',
        r !== false, `got ${r} — must be truthy/unknown, never a confident false`);
    } catch (e) {
      report('failure: an unreadable plan does NOT report "no medication" as fact', false, String(e).slice(0, 160));
    }
  } else {
    for (const n of ['tablet-union (4 checks)', 'join (2 checks)', 'ack (5 checks)', 'failure (1 check)']) {
      report(`behavioural: ${n}`, false, 'the rx surface does not exist yet');
    }
  }
}

// ---------------------------------------------------------------- 9b
// banners exist in source
{
  report('failure: an "unavailable" banner exists for missing plan data',
    /medication data (is )?unavailable/i.test(tabSrc));
  // "unmatched" alone is a pre-existing staging concept — require wording that ties
  // specifically to medication dogs that could not be joined to the board.
  report('failure: unjoined plan-medication dogs are surfaced by name',
    /(medication|prescription)[^.\n]{0,120}(could not be matched|not matched to the board|no matching dog)/i.test(tabSrc) ||
    /(could not be matched|not matched to the board)[^.\n]{0,120}(medication|prescription)/i.test(tabSrc));
}

// ---------------------------------------------------------------- 11/12
// submit + protected suites
{
  if (skipSpawn) {
    skip('protected: full suite green', 'FTBOARD_SKIP_SPAWN=1');
    skip('protected: android-scroll smoke', 'FTBOARD_SKIP_SPAWN=1');
  } else {
    const r = spawnSync(BASH, ['tests/run.sh'], { encoding: 'utf8', cwd: repoRoot, timeout: 25 * 60 * 1000 });
    const out = (r.stdout || '') + (r.stderr || '');
    report('protected: tests/run.sh exits 0 (backend 80, tablet 82, display 9, TV 20)',
      r.status === 0, `exit=${r.status}; ${out.slice(-250).replace(/\s+/g, ' ')}`);
    report('protected: the tablet suite still reports its full count',
      /tablet/i.test(out) && !/SOMETHING FAILED/.test(out));
    const a = spawnSync('node', ['tests/android-scroll.smoke.mjs'],
      { encoding: 'utf8', cwd: repoRoot, timeout: 10 * 60 * 1000 });
    report('protected: android-scroll smoke still passes (drag engine untouched)', a.status === 0,
      `exit=${a.status}`);
  }
}

console.log(`\n${checks} checks, ${failures} failure(s)${skipSpawn ? ' [SPAWN TESTS SKIPPED - not a full pass]' : ''}`);
process.exit(Math.min(failures, 250));
