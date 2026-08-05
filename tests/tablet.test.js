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

  // ============================================================================
  // S11 — the version-first sync loop (2026-08-05). This replaced BOTH the 5s full
  // getSession poll AND the independent 7s getSessionVersion heartbeat. Each check
  // below is a property the old two-loop design provided; losing any of them is a
  // regression, not an optimisation.
  // ============================================================================
  function syncBoot(opts) {
    opts = opts || {};
    const h = load(FIXED);
    const calls = [];
    const applied = [];
    let flushes = 0;
    h.api.stub({
      showToast: () => {}, renderAllPens: () => {}, renderStagingArea: () => {},
      updateConnectionUI: () => {}, updateStatus: () => {},
      flushQueue: async () => { flushes++; },
      applyRemoteState: r => applied.push(r),
      loadDogList: async () => { calls.push('DOGLIST'); },
    });
    h.api.initPens();
    h.api.syncState.initialLoadComplete = true;
    h.api.syncState.lastDogListRefresh = Date.now();   // init already fetched it
    h.api.syncState.lastSyncVersion = opts.version || 100;
    h.api.syncState.isOnline = opts.isOnline !== false;
    // Label each planned response so netLog can be read as a sequence of actions.
    const origin = h.state;
    return {
      h, applied, calls,
      get flushes() { return flushes; },
      // @36: session calls are POSTs to n8n carrying the action in the body.
      seq: () => origin.netLog.map(e =>
        e.action === 'getSessionVersion' ? 'VERSION'
        : e.action === 'getSession' ? 'SESSION'
        : e.url.indexOf('getDogList') !== -1 ? 'DOGLIST' : 'OTHER'),
      urls: () => origin.netLog.map(e => e.url),
    };
  }
  const vOK = v => ({ delayMs: 5, body: { success: true, version: v, count: 0 } });
  const sOK = v => ({ delayMs: 5, body: { success: true, version: v, count: 1, dogs: [], mealType: 'Lunch' } });

  console.log('\n=== S11 — version-first poll: unchanged board costs ONE cheap call ===');
  {
    const t = syncBoot({ version: 100 });
    t.h.state.netPlan = [vOK(100)];
    await t.h.api.pollForUpdates();
    check('probes getSessionVersion only', JSON.stringify(t.seq()) === '["VERSION"]', JSON.stringify(t.seq()));
    check('does NOT fetch the full session when nothing changed', t.applied.length === 0);
    check('still confirms reachability + drains the queue', t.flushes === 1);
  }

  console.log('\n=== S12 — a real change still triggers the full read ===');
  {
    const t = syncBoot({ version: 100 });
    t.h.state.netPlan = [vOK(200), sOK(200)];
    await t.h.api.pollForUpdates();
    check('escalates to getSession', JSON.stringify(t.seq()) === '["VERSION","SESSION"]', JSON.stringify(t.seq()));
    check('applies the remote state', t.applied.length === 1);
    check('advances lastSyncVersion', t.h.api.syncState.lastSyncVersion === 200);
  }

  console.log('\n=== S13 — REGRESSION GUARD: the loop must still run while EDITING ===');
  // The old 7s heartbeat existed precisely because pollForUpdates bailed out on
  // isSyncPaused(). If the merged loop skips while paused, an edit burst leaves the
  // queue undrained and the connection state unproven — the exact gap the heartbeat filled.
  {
    const t = syncBoot({ version: 100 });
    t.h.api.syncState.pause();
    t.h.state.netPlan = [vOK(200), sOK(200)];
    await t.h.api.pollForUpdates();
    check('still probes while paused', JSON.stringify(t.seq()) === '["VERSION"]', JSON.stringify(t.seq()));
    check('still drains the queue while paused', t.flushes === 1);
    check('but does NOT overwrite the board mid-edit', t.applied.length === 0);
    check('and leaves lastSyncVersion alone so the change is re-detected', t.h.api.syncState.lastSyncVersion === 100);
  }

  console.log('\n=== S14 — REGRESSION GUARD: the loop must still run while OFFLINE ===');
  // The old poll was gated on !isOnline, so recovery depended entirely on the heartbeat.
  // Re-adding that gate would make a dropped link unrecoverable without the manual button.
  {
    const t = syncBoot({ version: 100, isOnline: false });
    t.h.state.netPlan = [vOK(100)];
    await t.h.api.pollForUpdates();
    check('polls even though isOnline was false', JSON.stringify(t.seq()) === '["VERSION"]', JSON.stringify(t.seq()));
    check('a successful probe restores the connection', t.h.api.syncState.isOnline === true);
    check('and drains whatever queued up while offline', t.flushes === 1);
  }

  console.log('\n=== S15 — failure handling is unchanged (debounced, 2 strikes) ===');
  {
    // NB: since S18 each tick makes up to PROBE_ATTEMPTS probes, so a tick that must FAIL needs
    // every one of its attempts to fail — otherwise the harness's default success response
    // rescues the retry. One tick still counts exactly one strike (pinned by S19).
    const bad = () => ({ delayMs: 5, body: { success: false, error: 'boom' } });
    const t = syncBoot({ version: 100 });
    t.h.state.netPlan = [bad(), bad()];
    await t.h.api.pollForUpdates();
    check('one bad tick does NOT declare offline', t.h.api.syncState.isOnline === true);
    check('but it is counted', t.h.api.syncState.consecutiveFailures === 1,
      String(t.h.api.syncState.consecutiveFailures));
    t.h.state.netPlan = [bad(), bad()];
    await t.h.api.pollForUpdates();
    check('two consecutive bad ticks DO declare offline', t.h.api.syncState.isOnline === false);
    check('a failed version probe never fetches the full session', t.applied.length === 0);
  }

  console.log('\n=== S16 — a slow call must not stack ticks behind it ===');
  // isSyncing was vestigial before (read in the gate, never assigned). It is now the real
  // in-flight guard that heartbeatInFlight used to provide.
  {
    const t = syncBoot({ version: 100 });
    t.h.state.netPlan = [{ delayMs: 60, body: { success: true, version: 100, count: 0 } }];
    const inFlight = t.h.api.pollForUpdates();
    await t.h.api.pollForUpdates();          // fires while the first is still outstanding
    await inFlight;
    check('the overlapping tick was dropped, not queued', t.seq().length === 1, JSON.stringify(t.seq()));
  }

  // ============================================================================
  // S17–S20 — resilience against a BIMODAL /exec (2026-08-05). Measured live: ~60% of
  // calls answer in 2-4s, the rest take 15-48s or return Google's own 404 HTML page.
  // A flat 12s budget makes the tablet abort ITSELF and staff see "connection lost"
  // while the backend is healthy. Same class as the 2026-08-04 outage.
  // ============================================================================
  console.log('\n=== S17 — budgets: writes get 45s, the default stays 12s ===');
  {
    const { h } = boot(FIXED);
    const c = h.api.consts;
    check('default budget still 12s', c.FETCH_TIMEOUT_MS === 12000, String(c.FETCH_TIMEOUT_MS));
    check('write budget is 45s', c.SYNC_WRITE_TIMEOUT_MS === 45000, String(c.SYNC_WRITE_TIMEOUT_MS));
    check('the version probe retries once', c.PROBE_ATTEMPTS === 2, String(c.PROBE_ATTEMPTS));
  }

  console.log('\n=== S18 — a slow version probe RETRIES instead of latching offline ===');
  {
    const t = syncBoot({ version: 100 });
    // First probe hangs past the 12s budget (aborts), second answers fine.
    t.h.state.netPlan = [{ delayMs: 30000, body: { success: true, version: 100, count: 0 } }, vOK(100)];
    await t.h.api.pollForUpdates();
    check('it made a second attempt', t.seq().length === 2, JSON.stringify(t.seq()));
    check('the retry rescued the tick — NOT counted as a failure',
      t.h.api.syncState.consecutiveFailures === 0, String(t.h.api.syncState.consecutiveFailures));
    check('...so the tablet stays online', t.h.api.syncState.isOnline === true);
  }

  console.log('\n=== S19 — both probes failing still counts exactly ONE strike ===');
  {
    const t = syncBoot({ version: 100 });
    t.h.state.netPlan = [
      { delayMs: 30000, body: { success: true } },
      { delayMs: 30000, body: { success: true } },
    ];
    await t.h.api.pollForUpdates();
    check('two attempts were made', t.seq().length === 2, JSON.stringify(t.seq()));
    check('one tick = one strike, not two', t.h.api.syncState.consecutiveFailures === 1,
      String(t.h.api.syncState.consecutiveFailures));
    check('one bad tick does not declare offline', t.h.api.syncState.isOnline === true);
  }

  console.log('\n=== S20 — REGRESSION: a slow WRITE must not instantly kill the connection ===');
  // flushQueue used to set isOnline = false outright on any network error, bypassing
  // OFFLINE_THRESHOLD. Against a bimodal /exec that meant ONE slow POST disabled Submit.
  {
    const h = load(FIXED);
    h.api.stub({
      showToast: () => {}, renderAllPens: () => {}, renderStagingArea: () => {},
      updateConnectionUI: () => {}, updateStatus: () => {}, pauseSync: () => {},
    });
    h.api.initPens();
    h.api.syncState.initialLoadComplete = true;
    h.api.syncState.isOnline = true;
    h.api.syncState.queue = [{ op: 'update', dogId: 'd1', payload: { status: 'all' }, ts: Date.now() }];
    h.state.netPlan = [{ delayMs: 60000, body: { success: true } }];   // aborts at the 45s budget
    await h.api.flushQueue();
    check('a single aborted write does NOT declare offline', h.api.syncState.isOnline === true,
      'isOnline=' + h.api.syncState.isOnline);
    check('it is debounced like every other failure', h.api.syncState.consecutiveFailures === 1,
      String(h.api.syncState.consecutiveFailures));
    check('the edit stays queued for retry', h.api.syncState.queue.length === 1);
  }

  console.log('\n=== S21 — @36 ROUTING: the session must never go back to Apps Script ===');
  // The entire point of the n8n migration. Apps Script /exec measured a 4.5-8.7s median with a
  // 55.6s peak and ~40% of calls past the 12s budget; n8n measured 0.70s mean, 1.83s worst, zero
  // failures. If a session call drifts back onto GAS, "connection lost" comes straight back.
  {
    const t = syncBoot({ version: 100 });
    t.h.state.netPlan = [vOK(200), sOK(200)];
    await t.h.api.pollForUpdates();
    const urls = t.urls();
    check('the poll made both session calls', t.seq().join(',') === 'VERSION,SESSION', t.seq().join(','));
    check('...both to the n8n webhook',
      urls.length === 2 && urls.every(u => u.indexOf('auto.thefairytails.co.uk') !== -1),
      JSON.stringify(urls));
    check('...and NONE to script.google.com',
      urls.every(u => u.indexOf('script.google.com') === -1), JSON.stringify(urls));
  }
  {
    // A queued edit must also post to n8n, and carry the same action names the backend used,
    // so the durable queue's op shapes did not have to change.
    const h = load(FIXED);
    h.api.stub({
      showToast: () => {}, renderAllPens: () => {}, renderStagingArea: () => {},
      updateConnectionUI: () => {}, updateStatus: () => {}, pauseSync: () => {},
    });
    h.api.initPens();
    h.api.syncState.initialLoadComplete = true;
    h.api.syncState.isOnline = true;
    h.api.syncState.queue = [{ op: 'update', dogId: 'd1', payload: { status: 'all' }, ts: Date.now() }];
    h.state.netPlan = [{ delayMs: 5, body: { success: true, count: 1 } }];
    await h.api.flushQueue();
    const e = h.state.netLog[0];
    check('a queued mutation posts to n8n', e && e.url.indexOf('auto.thefairytails.co.uk') !== -1,
      e ? e.url : '(no call)');
    check('...using the unchanged updateDog action name', e && e.action === 'updateDog',
      e ? String(e.action) : '(none)');
    check('...and the queue drained', h.api.syncState.queue.length === 0);
  }
  {
    // The three endpoints that legitimately stay on Apps Script must NOT have moved.
    const { h } = boot(FIXED);
    h.state.netPlan = [{ delayMs: 5, body: { success: true, dogs: [{ name: 'A' }, { name: 'B' },
      { name: 'C' }, { name: 'D' }, { name: 'E' }, { name: 'F' }, { name: 'G' }, { name: 'H' },
      { name: 'I' }, { name: 'J' }, { name: 'K' }] } }];
    await h.api.loadDogList();
    const u = h.state.netLog[0].url;
    check('getDogList still goes to Apps Script', u.indexOf('script.google.com') !== -1 && u.indexOf('getDogList') !== -1, u);
  }

  console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
  process.exit(fail ? 1 : 0);
})();
