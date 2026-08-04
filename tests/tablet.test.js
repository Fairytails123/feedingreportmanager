// Acceptance scenarios for the "Add Dogs for Today" timeout fix.
// Runs the FIXED source and the PRE-FIX source (negative control) through the same cases.
const path = require('path');
const { load } = require('./tablet_harness');

const FIXED = process.env.FIXED_PATH || path.join(__dirname, '..', 'index.html');
// Optional: a PRE-FIX copy of index.html, used as a negative control (see S1). Get one with
//   git show <pre-fix-sha>:index.html > /tmp/old_index.html
// and pass OLD_PATH=/tmp/old_index.html. Skipped when not supplied.
const OLD = process.env.OLD_PATH;

const PLAN = {
  success: true, mealPeriod: 'Lunch', today: '2026-08-04',
  dogs: [
    { name: 'Betty McEwan', penGroup: 'top' },
    { name: 'Buddy Selby', penGroup: 'bottom' },
    { name: 'Digby Shaw', penGroup: 'bottom' },
  ],
  skipped: [], counts: { roster: 46, eligible: 3, skipped: 0 },
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

function boot(path) {
  const h = load(path);
  const toasts = [];
  const added = [];
  h.api.stub({
    showToast: (m, t) => toasts.push({ m, t }),
    syncAddDog: async d => { added.push(d); },
    syncMealType: async () => {},
    renderAllPens: () => {}, renderStagingArea: () => {}, updateConnectionUI: () => {},
    pauseSync: () => {},
    matchDogName: n => [n],
    fuzzyMatchDogName: () => [],
  });
  h.api.initPens();   // the real seeder — the page calls this during initialLoad()
  return { h, toasts, added };
}

async function scenario(label, path, netPlan) {
  const { h, toasts, added } = boot(path);
  h.state.netPlan = netPlan.slice();
  const t0 = Date.now();
  await h.api.addDogsForToday();
  return { toasts, added, ms: Date.now() - t0, attempts: h.state.netLog.length, consts: h.api.consts, pens: h.api.pens };
}

(async () => {
  console.log('\n=== S1 — NEGATIVE CONTROL: pre-fix code, 15s whiteboard response ===');
  if (!OLD) {
    console.log('  SKIP  no OLD_PATH supplied (see the note at the top of this file)');
  } else {
    const r = await scenario('old-slow', OLD, [{ delayMs: 15000, body: PLAN }]);
    const msg = r.toasts.map(t => t.m).join(' | ');
    console.log(`  toast: ${msg}`);
    check('pre-fix code FAILS on a 15s response (reproduces the report)',
      r.toasts.some(t => t.t === 'error') && /abort/i.test(msg), msg);
    check('pre-fix code adds NO dogs', r.added.length === 0, `added ${r.added.length}`);
    check('pre-fix message is the raw one staff saw', /signal is aborted without reason/.test(msg), msg);
  }

  console.log('\n=== S2 — FIXED: same 15s response now succeeds ===');
  {
    const r = await scenario('new-slow', FIXED, [{ delayMs: 15000, body: PLAN }]);
    const msg = r.toasts.map(t => t.m).join(' | ');
    console.log(`  toast: ${msg}  (${r.ms}ms, ${r.attempts} attempt(s))`);
    check('succeeds on a 15s response', r.toasts.some(t => t.t === 'success' || /Added 3/.test(t.m)), msg);
    check('all 3 dogs added', r.added.length === 3, `added ${r.added.length}`);
    check('single attempt — no needless retry', r.attempts === 1, `attempts ${r.attempts}`);
  }

  console.log('\n=== S3 — FIXED: honours pen sides (top vs bottom) ===');
  {
    const r = await scenario('pens', FIXED, [{ delayMs: 20, body: PLAN }]);
    const top = Object.keys(r.pens).filter(p => p.startsWith('top-')).flatMap(p => r.pens[p]);
    const bottom = Object.keys(r.pens).filter(p => p.startsWith('bottom-')).flatMap(p => r.pens[p]);
    check('1 dog on the top side', top.length === 1, `top ${top.length}`);
    check('2 dogs on the bottom side', bottom.length === 2, `bottom ${bottom.length}`);
    check('every queued add carries a penId-bearing dog', r.added.length === 3, `added ${r.added.length}`);
  }

  console.log('\n=== S4 — FIXED: first attempt times out, retry rescues it ===');
  {
    const r = await scenario('retry', FIXED, [
      { delayMs: 60000, body: PLAN },   // exceeds the 45s budget -> abort
      { delayMs: 500, body: PLAN },     // retry answers fast
    ]);
    const msg = r.toasts.map(t => t.m).join(' | ');
    console.log(`  toast: ${msg}  (${r.ms}ms, ${r.attempts} attempt(s))`);
    check('retried after the abort', r.attempts === 2, `attempts ${r.attempts}`);
    check('recovered and added all 3 dogs', r.added.length === 3, `added ${r.added.length}`);
    check('no error toast shown to staff', !r.toasts.some(t => t.t === 'error'), msg);
  }

  console.log('\n=== S5 — FIXED: both attempts time out -> human-readable message ===');
  {
    const r = await scenario('both-fail', FIXED, [
      { delayMs: 60000, body: PLAN },
      { delayMs: 60000, body: PLAN },
    ]);
    const msg = r.toasts.map(t => t.m).join(' | ');
    console.log(`  toast: ${msg}  (${r.attempts} attempt(s))`);
    check('exactly 2 attempts (no infinite loop)', r.attempts === 2, `attempts ${r.attempts}`);
    check('friendly timeout wording, not "signal is aborted"',
      /Timed out loading today's dogs/.test(msg) && !/signal is aborted/.test(msg), msg);
    check('tells staff to tap again', /Tap the button again/.test(msg), msg);
    check('no dogs added on total failure', r.added.length === 0, `added ${r.added.length}`);
  }

  console.log('\n=== S6 — FIXED: a real server error is NOT mislabelled a timeout ===');
  {
    const r = await scenario('server-err', FIXED, [
      { delayMs: 30, body: { success: false, error: 'Whiteboard fetch failed: 500' } },
      { delayMs: 30, body: { success: false, error: 'Whiteboard fetch failed: 500' } },
    ]);
    const msg = r.toasts.map(t => t.m).join(' | ');
    console.log(`  toast: ${msg}`);
    check('surfaces the real server error', /Whiteboard fetch failed: 500/.test(msg), msg);
    check('does NOT claim a timeout', !/Timed out/.test(msg), msg);
  }

  console.log('\n=== S7 — REGRESSION: other GAS calls keep the 12s budget ===');
  {
    const { h } = boot(FIXED);
    const c = h.api.consts;
    console.log(`  FETCH_TIMEOUT_MS=${c.FETCH_TIMEOUT_MS}  PLAN_FETCH_TIMEOUT_MS=${c.PLAN_FETCH_TIMEOUT_MS}  attempts=${c.PLAN_FETCH_ATTEMPTS}`);
    check('standard budget unchanged at 12s', c.FETCH_TIMEOUT_MS === 12000, String(c.FETCH_TIMEOUT_MS));
    check('plan budget is 45s', c.PLAN_FETCH_TIMEOUT_MS === 45000, String(c.PLAN_FETCH_TIMEOUT_MS));

    // A 2-arg gasFetch call (every pre-existing caller) must still abort at 12s.
    h.state.netPlan = [{ delayMs: 30000, body: { success: true } }];
    const t0 = Date.now();
    let aborted = false;
    try { await h.api.gasFetch('https://x/exec', { method: 'GET' }); }
    catch (e) { aborted = e.name === 'AbortError'; }
    const dt = Date.now() - t0;
    check('2-arg gasFetch still aborts', aborted, 'did not abort');
    check(`...and does so at ~12s (was ${dt}ms)`, dt >= 11500 && dt < 14000, `${dt}ms`);

    // A 3-arg call must honour the override.
    h.state.netPlan = [{ delayMs: 30000, body: { success: true } }];
    const t1 = Date.now();
    let aborted2 = false;
    try { await h.api.gasFetch('https://x/exec', { method: 'GET' }, 3000); }
    catch (e) { aborted2 = e.name === 'AbortError'; }
    const dt2 = Date.now() - t1;
    check(`3-arg override honoured (~3s, was ${dt2}ms)`, aborted2 && dt2 >= 2500 && dt2 < 5000, `${dt2}ms`);
  }

  console.log('\n=== S9 — stale board: warning must reach the BLOCKING dialog ===');
  {
    const STALE = Object.assign({}, PLAN, {
      stale: true,
      capturedAt: '2026-08-04T09:15:00.000Z',
      upstreamError: 'Whiteboard roster unavailable: HTTP 404',
    });
    const { h, toasts, added } = boot(FIXED);
    h.state.netPlan = [{ delayMs: 20, body: STALE }];
    await h.api.addDogsForToday();
    const cmsg = h.state.confirmMsgs.join('\n');
    check('confirm() dialog carries the NOT-live warning', /NOT live/i.test(cmsg), cmsg.slice(0, 200));
    check('...names the capture time', /\d{2}:\d{2}/.test(cmsg), cmsg.slice(0, 200));
    check('...surfaces the real upstream error, not a hardcoded guess',
      /HTTP 404/.test(cmsg), cmsg.slice(0, 200));
    check('...warns dogs may have left or be missing',
      /may still be on it/.test(cmsg) && /missing/.test(cmsg), cmsg.slice(0, 240));
    check('stale board still usable (dogs added after confirm)', added.length === 3,
      `added ${added.length}`);
  }
  {
    // A healthy plan must NOT carry the warning.
    const { h } = boot(FIXED);
    h.state.netPlan = [{ delayMs: 20, body: PLAN }];
    await h.api.addDogsForToday();
    const cmsg = h.state.confirmMsgs.join('\n');
    check('healthy plan shows NO stale warning', !/NOT live/i.test(cmsg), cmsg.slice(0, 160));
  }

  console.log('\n=== S10 — repeat press forces a cache bypass (fresh=1) ===');
  {
    const { h } = boot(FIXED);
    h.state.netPlan = [{ delayMs: 20, body: PLAN }, { delayMs: 20, body: PLAN }];
    await h.api.addDogsForToday();
    const first = h.state.netLog[0].url;
    await h.api.addDogsForToday();
    const second = h.state.netLog[1].url;
    check('first press does NOT force fresh (cache is allowed)', first.indexOf('fresh=1') === -1, first);
    check('second press DOES force fresh', second.indexOf('fresh=1') !== -1, second);
  }

  console.log('\n=== S8 — meal-period boundaries unchanged ===');
  {
    const { h } = boot(FIXED);
    const at = (hh, mm) => { const d = new Date(2026, 7, 4, hh, mm, 0); return h.api.computeMealPeriod(d); };
    check('09:59 -> Morning Meal', at(9, 59) === 'Morning Meal', at(9, 59));
    check('10:00 -> Lunch', at(10, 0) === 'Lunch', at(10, 0));
    check('13:59 -> Lunch', at(13, 59) === 'Lunch', at(13, 59));
    check('14:00 -> Evening Meal', at(14, 0) === 'Evening Meal', at(14, 0));
  }

  console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
  process.exit(fail ? 1 : 0);
})();
