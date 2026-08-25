// Acceptance tests for task `tablet-rx-empty-board` (contract: .task/contract.md).
//
// The defect: the tablet's persistent banner names every plan dog on medication that is not
// matched to the board - and it does so WHEN THE BOARD IS EMPTY. submitReport clears the board
// after every meal, so an empty board is the normal between-rounds state. Staff therefore see
// "Prescription medication dogs not matched to the board: ..." most of the day and learn to
// swipe past a SAFETY warning.
//
// Owner decision (Kam, 25/08): suppress when the board is empty; keep the in-round signal.
// The same rule was applied to the pens TV on 25/08 - the two surfaces must agree.
//
// Fixture names are FABRICATED. This repo is PUBLIC - never put a real customer dog name,
// owner surname or prescription detail in a test literal.
//
// Plain node, no framework: report() accumulator, exit code = failure count.
// Authored BEFORE implementation (tests-first) - criteria 1 must FAIL on the bare branch.
// Env: FTBOARD_SKIP_SPAWN=1 loudly skips spawn-dependent checks (Codex sandbox).
// OPERATOR-owned: the implementer must not edit this file.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const require = createRequire(import.meta.url);
const skipSpawn = process.env.FTBOARD_SKIP_SPAWN === '1';
const TABLET = join(repoRoot, 'index.html');
const BASH = process.env.FTBOARD_BASH || 'bash';

let failures = 0, checks = 0;
function report(name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -- ' + detail}`);
}
function skip(name, why) { console.log(`SKIP  ${name}  -- ${why} (NOT a pass)`); }

// Stays are computed RELATIVE TO TODAY. rxPlanDogIsStayingToday() compares against the real
// clock, so hard-coded dates would silently expire and this permanent suite would then fail
// every LATER task in this repo (the gate runs them all). Local getters, not toISOString().
const isoDay = (offset) => {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
};
const STAY_FROM = isoDay(-1);
const STAY_TO = isoDay(2);

const planDog = (dogName, ownerSurname, medication, over) => ({
  dogName, ownerSurname, checkIn: STAY_FROM, checkOut: STAY_TO, type: 'boarding',
  feeding: { medication, medicationDetails: medication === 'Yes' ? 'Twice daily tablet' : '' },
  ...(over || {}),
});

const PLAN_DOGS = [
  planDog('Wilbur', 'Quandle', 'Yes'),
  planDog('Bolt', 'Quixling', 'Yes'),
  planDog('Luna', 'Snorkelby', 'No'),
  // arrives tomorrow -> must never be named, even in-round
  planDog('Marbles', 'Fenwicket', 'Yes', { checkIn: isoDay(1), checkOut: isoDay(4) }),
];

const boardDog = (name) => ({
  id: 'd-' + name.replace(/\s+/g, '-'), inputName: name, matchedName: name,
  possibleMatches: [], status: 'all', prescription: false, prescriptionComment: '',
  supplements: false, supplementTypes: [], penId: 'top-1', position: 1000,
});

const goodPlan = () => ({ ok: true, dogs: PLAN_DOGS.map(d => ({ ...d })), fetchedAt: Date.now() });

console.log('=== tablet: the unjoined-medication warning ===');

let h = null, bootErr = null;
try { h = require('./tablet_harness').load(TABLET).api; } catch (e) { bootErr = e; }

if (!h || !h.rx || !h.rx.present) {
  const why = bootErr ? String(bootErr).slice(0, 200) : 'tablet harness rx surface unavailable';
  for (const n of ['empty board raises no unjoined warning',
                   'in-round a missing medication dog is still named',
                   'a joined medication dog is not named',
                   'a dog arriving tomorrow is not named',
                   'an unavailable plan returns empty']) {
    report(n, false, why);
  }
} else if (typeof h.rx.unjoined !== 'function' || h.rx.unjoined() === undefined) {
  for (const n of ['empty board raises no unjoined warning',
                   'in-round a missing medication dog is still named',
                   'a joined medication dog is not named',
                   'a dog arriving tomorrow is not named',
                   'an unavailable plan returns empty']) {
    report(n, false, 'no seam exposing rxMedicationPlanDogsNotOnBoard()');
  }
} else {
  const names = () => (h.rx.unjoined() || []).map(d => h.rx.displayName(d)).filter(Boolean);

  // 1 - THE DEFECT. No round in progress => nothing can be "missing" from it yet.
  h.rx.planState = goodPlan();
  h.setDogs([]);
  {
    const got = names();
    report('empty board raises no unjoined warning', got.length === 0,
      `the board is cleared after every meal, so this fires most of the day; got ${JSON.stringify(got)}`);
  }

  // 2 - the in-round signal must survive: a live board missing a medication dog still warns.
  h.rx.planState = goodPlan();
  h.setDogs([boardDog('Luna Snorkelby')]);   // on the board, NOT on medication
  {
    const got = names();
    report('in-round a missing medication dog is still named',
      got.some(n => /Wilbur/i.test(n)),
      `a medication dog absent from a LIVE board must still be named; got ${JSON.stringify(got)}`);
  }

  // 3 - a medication dog that IS on the board must not be named.
  h.rx.planState = goodPlan();
  h.setDogs([boardDog('Wilbur Quandle')]);
  {
    const got = names();
    report('a joined medication dog is not named', !got.some(n => /Wilbur/i.test(n)),
      `got ${JSON.stringify(got)}`);
  }

  // 4 - not staying today => never named (guards the date filter while we are in here).
  h.rx.planState = goodPlan();
  h.setDogs([boardDog('Luna Snorkelby')]);
  {
    const got = names();
    report('a dog arriving tomorrow is not named', !got.some(n => /Marbles/i.test(n)),
      `got ${JSON.stringify(got)}`);
  }

  // 5 - an unavailable plan is handled by the existing guard and must stay unchanged.
  h.rx.planState = { ok: false, dogs: null, fetchedAt: 0 };
  h.setDogs([boardDog('Luna Snorkelby')]);
  {
    const got = h.rx.unjoined() || [];
    report('an unavailable plan returns empty', got.length === 0,
      `got ${JSON.stringify(got.map(d => h.rx.displayName(d)))}`);
  }
}

console.log('\n=== protected suite ===');
if (skipSpawn) {
  skip('protected run.sh exits 0', 'FTBOARD_SKIP_SPAWN=1');
} else {
  const r = spawnSync(BASH, ['tests/run.sh'], { encoding: 'utf8', cwd: repoRoot, timeout: 25 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  report('protected run.sh exits 0', r.status === 0,
    `exit=${r.status}; ${out.slice(-250).replace(/\s+/g, ' ')}`);
}

console.log(`\n${checks} checks, ${failures} failure(s)${skipSpawn ? ' [SPAWN TESTS SKIPPED - not a full pass]' : ''}`);
process.exit(Math.min(failures, 250));
