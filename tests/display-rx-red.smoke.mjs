// Acceptance tests for task `pens-tv-rx-red` (contract: .task/contract.md).
//
// The objective: prescription medication must be impossible to overlook on the PENS TV
// (display/display.html -> frmdisplay), the screen staff read when putting dogs into kennels.
// The union rule is the tablet's: red when the board flag `dog.prescription` is true OR the
// joined boarding-plan record says `feeding.medication === 'Yes'`.
//
// The live defect this pins (25/08/2026): a boarding dog whose medication is declared ONLY in
// the boarding-plans feed reads red on the tablet and on the plans TV, and shows nothing at all
// on the pens TV, because that page reads only the n8n session and so cannot see plan-declared
// medication.
//
// FIXTURE NAMES BELOW ARE FABRICATED. This repo is PUBLIC - never put a real customer dog name,
// owner surname or prescription detail in a test literal. (INTEGRATION.md records the same
// mistake being caught once before, in the old TV harness.)
//
// Plain node, no framework: report() accumulator, exit code = failure count.
// Authored BEFORE implementation (tests-first) - must fail on the bare branch.
// Env: FTBOARD_SKIP_SPAWN=1 loudly skips spawn-dependent checks (Codex sandbox).
// OPERATOR-owned: the implementer must not edit this file.

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const require = createRequire(import.meta.url);
const skipSpawn = process.env.FTBOARD_SKIP_SPAWN === '1';

const DISPLAY = join(repoRoot, 'display', 'display.html');
const CONTRACT_JS = join(repoRoot, 'shared', 'contract.js');
const CHECK_JS = join(repoRoot, 'scripts', 'check_contract.js');
const TABLET = join(repoRoot, 'index.html');
const TVPLANS = join(repoRoot, 'tv-plans', 'index.html');
const BACKEND = join(repoRoot, 'feeding_report_backend_v2.js');
const ASSEMBLE = join(repoRoot, 'scripts', 'assemble_display.js');

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

const displaySrc = readText(DISPLAY) || '';
const contractSrc = readText(CONTRACT_JS) || '';
const checkSrc = readText(CHECK_JS) || '';
const tabletSrc = readText(TABLET) || '';
const tvPlansSrc = readText(TVPLANS) || '';
const backendSrc = readText(BACKEND) || '';

// ---------------------------------------------------------------------------
console.log('\n=== 1. Contract constants (D6) ===');
// ---------------------------------------------------------------------------
let C = null;
try {
  const ctx = vm.createContext({});
  vm.runInContext(contractSrc, ctx, { filename: 'shared/contract.js' });
  C = ctx.FRM_CONTRACT;
} catch (e) { /* leave C null */ }

report('contract exposes BOARDING_PLANS_URL and BOARDING_PLANS_TOKEN',
  !!(C && typeof C.BOARDING_PLANS_URL === 'string' && /\/exec$/.test(C.BOARDING_PLANS_URL)
     && typeof C.BOARDING_PLANS_TOKEN === 'string' && C.BOARDING_PLANS_TOKEN.length > 0),
  C ? `url=${C.BOARDING_PLANS_URL} token=${C.BOARDING_PLANS_TOKEN ? 'set' : 'MISSING'}` : 'contract did not evaluate');

{
  const grab = (src, re) => (src.match(re) || [])[2];
  const tabletUrl = grab(tabletSrc, /\bBOARDING_PLANS_API_URL\s*=\s*(['"])([^'"]+)\1/);
  const tabletTok = grab(tabletSrc, /\bBOARDING_PLANS_API_TOKEN\s*=\s*(['"])([^'"]+)\1/);
  const tvUrl = grab(tvPlansSrc, /\bAPI_URL\s*=\s*(['"])([^'"]+)\1/);
  const tvTok = grab(tvPlansSrc, /\bAPI_TOKEN\s*=\s*(['"])([^'"]+)\1/);
  const beUrl = grab(backendSrc, /\bCHECKINOUT_URL\s*:\s*(['"])([^'"]+)\1/);
  const beTok = grab(backendSrc, /\bCHECKINOUT_TOKEN\s*:\s*(['"])([^'"]+)\1/);
  const allUrl = C && [tabletUrl, tvUrl, beUrl].every(v => v !== undefined && v === C.BOARDING_PLANS_URL);
  const allTok = C && [tabletTok, tvTok, beTok].every(v => v !== undefined && v === C.BOARDING_PLANS_TOKEN);
  report('boarding-plans values agree across tablet plans-TV and backend', !!(allUrl && allTok),
    `tabletUrl=${tabletUrl === (C && C.BOARDING_PLANS_URL)} tvUrl=${tvUrl === (C && C.BOARDING_PLANS_URL)} beUrl=${beUrl === (C && C.BOARDING_PLANS_URL)}`);
}

report('display does not hardcode the boarding-plans URL or token',
  !!(C && !displaySrc.includes(C.BOARDING_PLANS_URL) && !displaySrc.includes(C.BOARDING_PLANS_TOKEN)),
  'the display must consume the contract, never copy it (check_contract.js enforces this class)');

report('display reads the boarding plans via FRM_CONTRACT',
  displaySrc.includes('FRM_CONTRACT.BOARDING_PLANS_URL') && displaySrc.includes('FRM_CONTRACT.BOARDING_PLANS_TOKEN'),
  'expected both FRM_CONTRACT.BOARDING_PLANS_URL and FRM_CONTRACT.BOARDING_PLANS_TOKEN in display/display.html');

report('check_contract enforces the boarding-plans constants',
  /BOARDING_PLANS_URL/.test(checkSrc) && /BOARDING_PLANS_TOKEN/.test(checkSrc)
    && /FRM_CONTRACT\.BOARDING_PLANS_URL/.test(checkSrc),
  'scripts/check_contract.js must assert the new contract keys across the surfaces');

// ---------------------------------------------------------------------------
console.log('\n=== 2. The red treatment (D8) ===');
// ---------------------------------------------------------------------------
const rxRule = cssRule(displaySrc, '.dog-card.has-rx');
report('a dog-card has-rx CSS rule exists', rxRule !== '',
  'no .dog-card.has-rx rule found in display/display.html');

report('the display defines a danger colour token', /--color-danger\s*:/.test(displaySrc),
  'the display palette is terracotta/sage only; medication needs its own danger token');

{
  // box-sizing: border-box + calculateScale() means ANY box change here perturbs the pen fit.
  const forbidden = /(^|;|\s)(width|height|min-width|min-height|max-width|max-height|padding|margin|font-size|gap|flex|border-width|border-left-width|border-right-width|border-top-width|border-bottom-width)\s*:/i;
  report('has-rx alters no box dimension', rxRule !== '' && !forbidden.test(rxRule),
    `rule body: ${rxRule.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
}
{
  // border-left is the portion/status channel every .dog-card.status-* rule owns.
  const touchesLeft = /border-left(-color)?\s*:/i.test(rxRule) || /(^|;|\s)border\s*:/i.test(rxRule);
  report('has-rx does not override border-left-color', rxRule !== '' && !touchesLeft,
    `rule body: ${rxRule.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
}

report('banner unavailable medication data is visibly flagged',
  /rxPlanUnavailable/.test(displaySrc) && /medication/i.test(displaySrc)
    && (displaySrc.match(/rxPlanUnavailable/g) || []).length >= 2,
  'expected rxPlanUnavailable() to exist AND be consumed by the banner path, with user-facing copy naming medication');

report('poll the plan fetch has its own in-flight guard',
  /planFetchInFlight/.test(displaySrc) && /loadInFlight/.test(displaySrc) && /versionCheckInFlight/.test(displaySrc),
  'the plan fetch needs its own guard and must not disturb the session guards (D4)');

// ---------------------------------------------------------------------------
console.log('\n=== 3. Behaviour: union, join, outage (D1, D2, D7) ===');
// ---------------------------------------------------------------------------
function bootDisplay() {
  const assembled = join(tmpdir(), 'frm_rxred_' + process.pid + '.html');
  execFileSync(process.execPath, [ASSEMBLE, assembled]);
  const html = readFileSync(assembled, 'utf8');
  try { unlinkSync(assembled); } catch (e) {}

  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  const src = blocks.join('\n;\n');

  const els = {};
  const el = id => els[id] || (els[id] = (() => {
    const o = {
      id, textContent: '', innerHTML: '', style: {},
      _cls: new Set(),
      appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 1920, height: 1080, top: 0, left: 0 }),
    };
    Object.defineProperty(o, 'className', {
      get() { return [...o._cls].join(' '); },
      set(v) { o._cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
    });
    o.classList = {
      add: c => o._cls.add(c), remove: c => o._cls.delete(c),
      contains: c => o._cls.has(c),
      toggle: c => (o._cls.has(c) ? o._cls.delete(c) : o._cls.add(c)),
    };
    return o;
  })());

  const document = {
    getElementById: el, querySelector: () => null, querySelectorAll: () => [],
    createElement: t => el('new-' + t),
    addEventListener() {}, removeEventListener() {},
    body: el('body'), documentElement: el('html'), readyState: 'complete',
  };
  const win = {
    document, fetch: () => Promise.reject(new Error('no network in test')),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
    location: { href: 'https://fairytails123.github.io/frmdisplay/', reload() {} },
    navigator: { onLine: true }, innerWidth: 1920, innerHeight: 1080,
    requestAnimationFrame: () => 0, AbortController,
  };
  win.window = win;
  const sandbox = {
    window: win, document, fetch: win.fetch, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    AbortController, Date, Math, JSON, Object, Array, String, Number, Boolean,
    Promise, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, navigator: win.navigator,
    location: win.location, requestAnimationFrame: win.requestAnimationFrame,
  };

  // Every entry typeof-guarded so this harness still LOADS against a build predating the
  // feature: the tests-first run must FAIL on missing behaviour, never crash on a ReferenceError.
  const EXPORTS = [
    'return {',
    '  get present() { return typeof dogNeedsRx !== "undefined"; },',
    '  needs: (...a) => (typeof dogNeedsRx !== "undefined" ? dogNeedsRx(...a) : undefined),',
    '  planFor: (...a) => (typeof rxPlanFor !== "undefined" ? rxPlanFor(...a) : undefined),',
    '  normName: (...a) => (typeof normRxName !== "undefined" ? normRxName(...a) : undefined),',
    '  applyPlan: (...a) => (typeof applyRxPlanResult !== "undefined" ? applyRxPlanResult(...a) : undefined),',
    '  unavailable: (...a) => (typeof rxPlanUnavailable !== "undefined" ? rxPlanUnavailable(...a) : undefined),',
    '  get planState() { return typeof rxPlanState !== "undefined" ? rxPlanState : undefined; },',
    '  set planState(v) { if (typeof rxPlanState !== "undefined") rxPlanState = v; },',
    '  get planTimeout() { return typeof PLAN_FETCH_TIMEOUT_MS !== "undefined" ? PLAN_FETCH_TIMEOUT_MS : undefined; },',
    '  get sessionTimeout() { return FRM_CONTRACT.FETCH_TIMEOUT_MS; },',
    '  get pens() { return typeof pens !== "undefined" ? pens : undefined; },',
    '  renderPen: (...a) => (typeof renderPen !== "undefined" ? renderPen(...a) : undefined),',
    '  setPlanMonitoring: (v) => { if (typeof planMonitoringStarted !== "undefined") planMonitoringStarted = v; },',
    '  setConnState: (o) => { if (o && typeof consecutiveFailures !== "undefined" && "failures" in o) consecutiveFailures = o.failures; if (o && typeof lastSuccessAt !== "undefined" && "lastSuccessAt" in o) lastSuccessAt = o.lastSuccessAt; },',
    '  updateBanner: (...a) => (typeof updateStaleBanner !== "undefined" ? updateStaleBanner(...a) : undefined),',
    '  unjoined: (...a) => (typeof rxPlanMedicationDogsNotOnBoard !== "undefined" ? rxPlanMedicationDogsNotOnBoard(...a) : undefined),',
    '};',
  ].join('\n');

  const names = Object.keys(sandbox);
  const api = new Function(...names, src + '\n' + EXPORTS)(...names.map(n => sandbox[n]));
  return { api, els };
}

const mk = (name, presc) => ({
  id: 'd-' + name.replace(/\s+/g, '-'), inputName: name, matchedName: name,
  possibleMatches: [], status: 'all', prescription: !!presc, prescriptionComment: '',
  supplements: false, supplementTypes: [], penId: 'top-1', position: 1000,
});
// Fixture stays are computed RELATIVE TO TODAY on purpose. rxPlanDogIsStayingToday()
// compares against the real clock, so hard-coded dates would silently expire and this
// permanent suite would then fail every LATER task in this repo (the gate runs them all).
const isoDay = (offset) => {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  const p2 = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate());
};
const STAY_FROM = isoDay(-1);   // checked in yesterday
const STAY_TO   = isoDay(2);    // leaves the day after tomorrow -> staying today, any day

const PLAN_DOGS = [
  { dogName: 'Wilbur', ownerSurname: 'Quandle', checkIn: STAY_FROM, checkOut: STAY_TO,
    type: 'boarding', feeding: { medication: 'Yes', medicationDetails: 'Twice daily tablet' } },
  { dogName: 'Bolt', ownerSurname: 'Quixling', checkIn: STAY_FROM, checkOut: STAY_TO,
    type: 'boarding', feeding: { medication: 'Yes', medicationDetails: 'x' } },
  { dogName: 'Luna', ownerSurname: 'Snorkelby', checkIn: STAY_FROM, checkOut: STAY_TO,
    type: 'boarding', feeding: { medication: 'No', medicationDetails: '' } },
];
const goodPlan = () => ({ ok: true, dogs: PLAN_DOGS.map(d => ({ ...d })), error: '', capturedAt: Date.now() });

if (skipSpawn) {
  for (const n of ['union (4 checks)', 'join (2 checks)', 'outage (4 checks)', 'render (2 checks)',
                   'budget (1 check)', 'parity (1 check)']) {
    skip(`behavioural: ${n}`, 'FTBOARD_SKIP_SPAWN=1');
  }
} else {
  let d = null, bootErr = null;
  try { d = bootDisplay(); } catch (e) { bootErr = e; }
  report('display harness loads the assembled page', d !== null,
    bootErr ? String(bootErr).slice(0, 220) : '');

  if (d && d.api && d.api.present) {
    const api = d.api;

    // --- union -----------------------------------------------------------
    api.planState = goodPlan();
    const planOnly = mk('Bolt Quixling', false);
    const staffOnly = mk('Zephyr Testerly', true);
    const both = mk('Bolt Quixling', true);
    const neither = mk('Luna Snorkelby', false);
    report('union staff-flagged prescription reads red', api.needs(staffOnly) === true,
      `got ${JSON.stringify(api.needs(staffOnly))}`);
    report('union plan-declared medication reads red', api.needs(planOnly) === true,
      `got ${JSON.stringify(api.needs(planOnly))}`);
    report('union both reads red', api.needs(both) === true, `got ${JSON.stringify(api.needs(both))}`);
    report('union neither does not read red', api.needs(neither) === false,
      `got ${JSON.stringify(api.needs(neither))}`);

    // --- join: THE reported defect ---------------------------------------
    api.planState = goodPlan();
    const planOnlyDog = mk('Wilbur Quandle', false);
    report('join plan dogName plus ownerSurname matches a combined board name',
      api.needs(planOnlyDog) === true,
      `the live 25/08 defect shape: plan {dogName:<first>, ownerSurname:<surname>} vs a combined board matchedName; got ${JSON.stringify(api.needs(planOnlyDog))}`);
    report('join normalisation folds case spacing and curly apostrophes',
      typeof api.normName('x') === 'string'
        && api.normName('  O\u2019Malley   Reed ') === api.normName("o'malley reed"),
      `got ${JSON.stringify(api.normName('  O\u2019Malley   Reed '))} vs ${JSON.stringify(api.normName("o'malley reed"))}`);

    // --- outage (D1 / D2) -------------------------------------------------
    api.planState = { ok: false, dogs: null, error: '', capturedAt: 0 };
    api.applyPlan(null, 'network down');
    report('outage a failed plan read never reads as no-medication',
      api.needs(mk('Bolt Quixling', false)) === null,
      `a failed read must be UNKNOWN (null), never false; got ${JSON.stringify(api.needs(mk('Bolt Quixling', false)))}`);
    report('outage the staff-flagged half still reads red when the plan feed is down',
      api.needs(mk('Zephyr Testerly', true)) === true,
      `got ${JSON.stringify(api.needs(mk('Zephyr Testerly', true)))}`);

    api.planState = { ok: false, dogs: null, error: '', capturedAt: 0 };
    api.applyPlan({ success: true, dogCount: 0 }, '');
    report('outage a 200 without a dogs array is an outage',
      !!(api.planState && api.planState.ok === false),
      `planState=${JSON.stringify(api.planState)}`);

    api.planState = { ok: false, dogs: null, error: '', capturedAt: 0 };
    api.applyPlan({ dogs: PLAN_DOGS.map(x => ({ ...x })) }, '');
    const goodCount = api.planState && Array.isArray(api.planState.dogs) ? api.planState.dogs.length : -1;
    api.applyPlan(null, 'boom');
    const afterCount = api.planState && Array.isArray(api.planState.dogs) ? api.planState.dogs.length : -1;
    report('outage a failure never overwrites the last good snapshot',
      goodCount === PLAN_DOGS.length && afterCount === goodCount,
      `good=${goodCount} afterFailure=${afterCount}`);

    // --- budget (D5) ------------------------------------------------------
    report('budget the plan fetch does not use the session timeout',
      typeof api.planTimeout === 'number' && api.planTimeout > api.sessionTimeout,
      `plan=${api.planTimeout} session=${api.sessionTimeout} (12s aborts a legitimately slow feed - the 2026-08-04 defect)`);

    // --- render -----------------------------------------------------------
    if (api.pens && api.renderPen) {
      api.planState = goodPlan();
      const pens = api.pens;
      pens['top-1'].length = 0;
      pens['top-1'].push(mk('Wilbur Quandle', false));
      api.renderPen('top-1');
      const medHtml = (d.els['dogs-top-1'] || {}).innerHTML || '';
      report('render a medication dog tile carries has-rx and a MED badge',
        /has-rx/.test(medHtml) && /\bMED\b/.test(medHtml),
        medHtml.replace(/\s+/g, ' ').slice(0, 220));

      pens['top-2'] = pens['top-2'] || [];
      pens['top-2'].length = 0;
      pens['top-2'].push(mk('Luna Snorkelby', false));
      api.renderPen('top-2');
      const plainHtml = (d.els['dogs-top-2'] || {}).innerHTML || '';
      report('render a non-medication dog tile carries neither',
        plainHtml !== '' && !/has-rx/.test(plainHtml) && !/\bMED\b/.test(plainHtml),
        plainHtml.replace(/\s+/g, ' ').slice(0, 220));
    } else {
      report('render a medication dog tile carries has-rx and a MED badge', false, 'renderPen/pens not reachable');
      report('render a non-medication dog tile carries neither', false, 'renderPen/pens not reachable');
    }

    // --- parity with the tablet (the actual requirement) -------------------
    let t = null;
    try { t = require('./tablet_harness').load(TABLET); } catch (e) { t = null; }
    const th = t ? t.api : null;
    if (th && th.rx && th.rx.present) {
      try { th.rx.planState = { ok: true, dogs: PLAN_DOGS.map(x => ({ ...x })), fetchedAt: Date.now() }; } catch {}
      api.planState = goodPlan();
      const cases = [
        mk('Wilbur Quandle', false), mk('Bolt Quixling', false), mk('Zephyr Testerly', true),
        mk('Bolt Quixling', true), mk('Luna Snorkelby', false),
      ];
      const diffs = cases
        .map(c => ({ n: c.matchedName, p: c.prescription, tv: api.needs(c), tab: th.rx.needs(c) }))
        .filter(r => r.tv !== r.tab);
      report('parity display and tablet agree on the same inputs', diffs.length === 0,
        JSON.stringify(diffs).slice(0, 300));
    } else {
      report('parity display and tablet agree on the same inputs', false,
        'tablet harness rx surface unavailable');
    }

    // --- R1: defects found by the independent blind review (criteria 28-34) ---
    // Each one below is a real failure mode of the FIRST implementation, not a style point.

    // C28 (F1): the medication warning must EXTEND the board banner, never replace it.
    // The two feeds fail together (one TV network drop), so replacing the board message
    // destroys the as-of time in exactly the scenario the banner exists for.
    if (api.updateBanner && api.setPlanMonitoring && api.setConnState) {
      api.setPlanMonitoring(true);
      api.planState = { ok: false, dogs: null, error: 'plan feed down', capturedAt: 0 };
      api.setConnState({ failures: 5, lastSuccessAt: Date.now() - 20 * 60 * 1000 });
      api.updateBanner();
      const bt = (d.els['staleBannerText'] || {}).textContent || '';
      report('banner medication warning composes with the board connection message',
        /medication/i.test(bt) && /\d{1,2}:\d{2}/.test(bt)
          && /connection lost|board as it stood/i.test(bt),
        `the board message AND its as-of time must survive; banner read: "${bt.slice(0, 240)}"`);
      api.setPlanMonitoring(false);
      api.setConnState({ failures: 0, lastSuccessAt: Date.now() });
    } else {
      report('banner medication warning composes with the board connection message', false,
        'harness cannot reach planMonitoringStarted / consecutiveFailures / updateStaleBanner');
    }

    // C29 (F2): an empty roster with NO error is a legitimate quiet boarding day.
    // Treating it as an outage parks a red banner on the TV all day (the 2026-08-04 pattern).
    api.planState = { ok: false, dogs: null, error: '', capturedAt: 0 };
    api.applyPlan({ success: true, dogs: [] }, '');
    report('outage an empty dogs array with no error is a quiet day',
      !!(api.planState && api.planState.ok === true),
      `a quiet day must not black the TV out; planState=${JSON.stringify(api.planState)}`);

    // C30 (F2): ...but an empty roster that CARRIES an error is still an outage.
    api.planState = { ok: false, dogs: null, error: '', capturedAt: 0 };
    api.applyPlan({ success: false, dogs: [], error: 'upstream failed' }, '');
    report('outage an empty dogs array carrying an error is an outage',
      !!(api.planState && api.planState.ok === false),
      `planState=${JSON.stringify(api.planState)}`);

    // C31 (F3): the retained snapshot must be READ, positively, during an outage -
    // otherwise the TV drops the red while the tablet keeps it, and the two disagree again.
    api.planState = { ok: false, dogs: null, error: '', capturedAt: 0 };
    api.applyPlan({ dogs: PLAN_DOGS.map(x => ({ ...x })) }, '');
    api.applyPlan(null, 'plan feed down');
    {
      const medDog = api.needs(mk('Wilbur Quandle', false));
      const plainDog = api.needs(mk('Luna Snorkelby', false));
      report('outage a retained snapshot still reads red for a plan-declared dog',
        medDog === true && plainDog === null,
        `med=${JSON.stringify(medDog)} (want true) plain=${JSON.stringify(plainDog)} (want null, never false)`);
    }

    // C32 (F5): a degraded payload (dogs AND an error) can be missing a dog's feeding
    // block entirely, so it must warn rather than answer a confident "no medication".
    api.planState = { ok: false, dogs: null, error: '', capturedAt: 0 };
    api.applyPlan({ dogs: PLAN_DOGS.map(x => ({ ...x })), error: 'partial roster' }, '');
    report('banner a degraded payload raises the medication warning',
      api.planState.ok === true && api.unavailable() === true,
      `ok=${api.planState.ok} (want true) unavailable=${api.unavailable()} (want true)`);

    // C33 (F6): a medication dog the join misses is currently invisible on the TV.
    // The tablet names these; the surface staff read at the kennel must too.
    // NOTE: a ROUND MUST BE IN PROGRESS for this warning to mean anything. The board is
    // cleared by submitReport after every meal, so an empty board is the normal
    // between-rounds state - warning then would light the banner most of the day
    // (owner decision, Kam 25/08: suppress on an empty board, keep the in-round signal).
    // C35 below pins the empty-board half; this one pins the in-round half.
    if (api.unjoined && api.unjoined() !== undefined) {
      api.planState = goodPlan();
      if (api.pens) Object.keys(api.pens).forEach(k => { api.pens[k].length = 0; });
      api.pens['top-1'].push(mk('Luna Snorkelby', false));   // a round IS in progress
      const names = api.unjoined() || [];
      report('banner a plan medication dog that joins no tile is named',
        Array.isArray(names) && names.some(n => /Wilbur/i.test(String(n))),
        `a medication dog missing from a LIVE board must still be named; got ${JSON.stringify(names).slice(0, 200)}`);

      // C35: ...but say nothing when no round is in progress.
      Object.keys(api.pens).forEach(k => { api.pens[k].length = 0; });
      const quiet = api.unjoined() || [];
      report('banner an empty board raises no unjoined-medication warning',
        Array.isArray(quiet) && quiet.length === 0,
        `the board is cleared after every meal - warning between rounds lights the banner all day; got ${JSON.stringify(quiet).slice(0, 200)}`);
    } else {
      report('banner a plan medication dog that joins no tile is named', false,
        'no seam exposing unjoined plan-medication dogs (expected rxPlanMedicationDogsNotOnBoard())');
      report('banner an empty board raises no unjoined-medication warning', false,
        'no seam exposing unjoined plan-medication dogs');
    }

    // C34 (F7): dark-brown-on-red is illegible at TV distance and redundant beside MED.
    if (api.pens && api.renderPen) {
      api.planState = goodPlan();
      api.pens['top-4'] = api.pens['top-4'] || [];
      api.pens['top-4'].length = 0;
      api.pens['top-4'].push(mk('Wilbur Quandle', true));  // staff-flagged AND plan-declared
      api.renderPen('top-4');
      const h = (d.els['dogs-top-4'] || {}).innerHTML || '';
      report('render a red tile suppresses the duplicate prescription pill',
        /has-rx/.test(h) && /\bMED\b/.test(h) && !/indicator-p/.test(h),
        h.replace(/\s+/g, ' ').slice(0, 220));
    } else {
      report('render a red tile suppresses the duplicate prescription pill', false,
        'renderPen/pens not reachable');
    }
  } else {
    for (const n of ['union staff-flagged prescription reads red', 'union plan-declared medication reads red',
                     'union both reads red', 'union neither does not read red',
                     'join plan dogName plus ownerSurname matches a combined board name',
                     'join normalisation folds case spacing and curly apostrophes',
                     'outage a failed plan read never reads as no-medication',
                     'outage the staff-flagged half still reads red when the plan feed is down',
                     'outage a 200 without a dogs array is an outage',
                     'outage a failure never overwrites the last good snapshot',
                     'budget the plan fetch does not use the session timeout',
                     'render a medication dog tile carries has-rx and a MED badge',
                     'render a non-medication dog tile carries neither',
                     'parity display and tablet agree on the same inputs',
                     'banner medication warning composes with the board connection message',
                     'outage an empty dogs array with no error is a quiet day',
                     'outage an empty dogs array carrying an error is an outage',
                     'outage a retained snapshot still reads red for a plan-declared dog',
                     'banner a degraded payload raises the medication warning',
                     'banner a plan medication dog that joins no tile is named',
                     'render a red tile suppresses the duplicate prescription pill',
                     'banner an empty board raises no unjoined-medication warning']) {
      report(n, false, 'the display rx surface does not exist yet');
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Publish path and the protected suite ===');
// ---------------------------------------------------------------------------
if (skipSpawn) {
  skip('publish assemble produces a page carrying the new contract keys', 'FTBOARD_SKIP_SPAWN=1');
  skip('protected run.sh exits 0', 'FTBOARD_SKIP_SPAWN=1');
} else {
  try {
    const out = join(tmpdir(), 'frm_rxred_pub_' + process.pid + '.html');
    execFileSync(process.execPath, [ASSEMBLE, out]);
    const page = readFileSync(out, 'utf8');
    try { unlinkSync(out); } catch (e) {}
    report('publish assemble produces a page carrying the new contract keys',
      page.includes('BOARDING_PLANS_URL') && page.includes('BOARDING_PLANS_TOKEN')
        && page.includes('has-rx'),
      'the assembled page must carry the injected contract keys and the red hook');
  } catch (e) {
    report('publish assemble produces a page carrying the new contract keys', false, String(e).slice(0, 200));
  }

  const r = spawnSync(BASH, ['tests/run.sh'], { encoding: 'utf8', cwd: repoRoot, timeout: 25 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  report('protected run.sh exits 0', r.status === 0,
    `exit=${r.status}; ${out.slice(-250).replace(/\s+/g, ' ')}`);
}

console.log(`\n${checks} checks, ${failures} failure(s)${skipSpawn ? ' [SPAWN TESTS SKIPPED - not a full pass]' : ''}`);
process.exit(Math.min(failures, 250));
