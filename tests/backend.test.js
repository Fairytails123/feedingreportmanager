// Acceptance suite for the getTodayPlan hardening.
// Encodes the CONTRACT; run against the real backend before any clasp deploy.
const path = require('path');
const { load, penSheetFixture, rosterFixture, boardFixture, BOARD_HEADERS, ERROR_PAGE } =
  require('./backend_harness');

const BACKEND = process.env.BACKEND || path.join(__dirname, '..', 'feeding_report_backend_v2.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; failures.push(name); }
}

function boot(resp) {
  const h = load(BACKEND);
  h.state.penSheetRows = penSheetFixture();
  if (resp) h.state.responses = resp;
  return h;
}

const OK = () => ({ code: 200, body: rosterFixture() });
const BAD = (sleepMs) => ({ code: 404, body: ERROR_PAGE, sleepMs: sleepMs || 20000 });

const CHECKIN = () => ({
  code: 200,
  body: JSON.stringify({
    stays: [
      { dogName: 'Betty McEwan', checkIn: '2026-08-01', checkOut: '2026-08-06', type: 'boarding' },
      { dogName: 'Digby Shaw', checkIn: '2026-08-04', checkOut: '2026-08-09', type: 'boarding' },
      { dogName: 'Leaving Today', checkIn: '2026-08-01', checkOut: '2026-08-04', type: 'boarding' },
    ],
  }),
});

console.log('\n=== A. Happy paths unchanged ===');
{
  const h = boot({ 'action=loadToday': [OK()] });
  const r = h.api.getTodayPlan('Lunch');
  check('Lunch: success', r.success === true, JSON.stringify(r).slice(0, 200));
  check('Lunch: 4 eligible dogs', r.dogs.length === 4, `got ${r.dogs.length}`);
  check('Lunch: George Elliston skipped (Y but no pen)',
    (r.skipped || []).indexOf('George Elliston') !== -1, JSON.stringify(r.skipped));
  check('Lunch: "Nolunch Dog" excluded (pen but no Y)',
    !r.dogs.some(d => d.name === 'Nolunch Dog'), JSON.stringify(r.dogs));
  check('Lunch: top group sorts first',
    r.dogs[0].penGroup === 'top', JSON.stringify(r.dogs.map(d => d.penGroup)));
}
{
  const h = boot({ 'mode=checkinout': [CHECKIN()] });
  const rm = h.api.getTodayPlan('Morning Meal');
  check('Breakfast: success', rm.success === true);
  check('Breakfast: includes a dog leaving this morning',
    rm.dogs.some(d => d.name === 'Leaving Today'), JSON.stringify(rm.dogs));
  check('Breakfast: excludes today\'s arrival',
    !rm.dogs.some(d => d.name === 'Digby Shaw'), JSON.stringify(rm.dogs));

  const h2 = boot({ 'mode=checkinout': [CHECKIN()] });
  const re = h2.api.getTodayPlan('Evening Meal');
  check('Dinner: includes today\'s check-in',
    re.dogs.some(d => d.name === 'Digby Shaw'), JSON.stringify(re.dogs));
  check('Dinner: excludes today\'s check-out',
    !re.dogs.some(d => d.name === 'Leaving Today'), JSON.stringify(re.dogs));
}

console.log('\n=== B. THE BUG: upstream failure must NOT look like an empty day ===');
{
  const h = boot({ 'action=loadToday': [BAD()] });
  const r = h.api.getTodayPlan('Lunch');
  const silentEmpty = (r.success === true && (r.dogs || []).length === 0 && !r.stale);
  check('Lunch 404 is NOT reported as a successful empty day', !silentEmpty,
    `success=${r.success} dogs=${(r.dogs || []).length} stale=${r.stale}`);
  check('Lunch 404 gives the client something actionable',
    r.success === false ? !!r.error : !!r.stale,
    JSON.stringify(r).slice(0, 240));
}
{
  const h = boot({ 'mode=checkinout': [BAD()] });
  const r = h.api.getTodayPlan('Morning Meal');
  const silentEmpty = (r.success === true && (r.dogs || []).length === 0 && !r.stale);
  check('Breakfast 404 is NOT reported as a successful empty day', !silentEmpty,
    `success=${r.success} dogs=${(r.dogs || []).length}`);
}

console.log('\n=== C. A GENUINELY empty roster is still a success ===');
{
  const h = boot({ 'action=loadToday': [{ code: 200, body: JSON.stringify({ dogs: [] }) }] });
  const r = h.api.getTodayPlan('Lunch');
  check('empty-but-healthy roster => success:true, 0 dogs',
    r.success === true && r.dogs.length === 0, JSON.stringify(r).slice(0, 200));
  check('...and is NOT marked stale', !r.stale, `stale=${r.stale}`);
}

console.log('\n=== D. Retry policy is deliberately asymmetric (see P4/P5) ===');
{
  // Whiteboard: NO retry. Its failures take 16-43s so a retry could never clear the deadline
  // gate, and the producer documents it degrades under concurrent load — retrying would
  // deepen the outage. A transient failure must fail honestly and let cache/LKG do the work.
  const h = boot({ 'action=loadToday': [BAD(3000), OK()] });
  const r = h.api.getTodayPlan('Lunch');
  check('whiteboard does NOT retry (would worsen a load-driven outage)',
    h.state.fetchLog.length === 1, `attempts=${h.state.fetchLog.length}`);
  check('...and fails honestly rather than as an empty day',
    r.success === false && !!r.error, JSON.stringify(r).slice(0, 200));
}
{
  // Check-in/out feed: retry IS armed. It is fast (2-6s) and healthy, so a retry fits well
  // inside the deadline gate and rescues a genuine blip.
  const h = boot({ 'mode=checkinout': [{ code: 500, body: 'oops', sleepMs: 1000 }, CHECKIN()] });
  const r = h.api.getTodayPlan('Morning Meal');
  check('check-in feed retries a fast transient failure', h.state.fetchLog.length >= 2,
    `attempts=${h.state.fetchLog.length}`);
  check('...and recovers', r.success === true && r.dogs.length > 0,
    JSON.stringify(r).slice(0, 200));
}

console.log('\n=== E. Retry budget is bounded (tablet aborts at 45s) ===');
{
  const h = boot({ 'action=loadToday': [BAD(20000), BAD(20000), BAD(20000), BAD(20000), BAD(20000)] });
  const t0 = h.state.now;
  h.api.getTodayPlan('Lunch');
  const simulatedMs = h.state.now - t0;
  check(`worst-case wall clock stays under 45s (simulated ${Math.round(simulatedMs / 1000)}s)`,
    simulatedMs < 45000, `${simulatedMs}ms across ${h.state.fetchLog.length} attempts`);
  check('does not retry-storm the upstream (<= 3 attempts)',
    h.state.fetchLog.length <= 3, `attempts=${h.state.fetchLog.length}`);
}

console.log('\n=== F. Cache: a warm plan avoids the flaky upstream entirely ===');
{
  const h = boot({ 'action=loadToday': [OK()] });
  const r1 = h.api.getTodayPlan('Lunch');
  const after1 = h.state.fetchLog.length;
  const r2 = h.api.getTodayPlan('Lunch');
  const after2 = h.state.fetchLog.length;
  check('first call fetches upstream', after1 >= 1, `${after1}`);
  check('second call within TTL makes NO upstream fetch', after2 === after1,
    `${after1} -> ${after2}`);
  check('cached result equals the fresh one',
    JSON.stringify(r2.dogs) === JSON.stringify(r1.dogs), 'dogs differ');
}

console.log('\n=== G. Last-known-good rescues a later outage ===');
{
  const h = boot({ 'action=loadToday': [OK(), BAD(20000), BAD(20000), BAD(20000)] });
  const good = h.api.getTodayPlan('Lunch');
  check('primed with a good plan', good.success && good.dogs.length === 4);
  // Expire the FRESH copy but leave last-known-good alive.
  h.state.now += 5 * 60 * 1000;
  const r = h.api.getTodayPlan('Lunch');
  check('outage serves last-known-good instead of an empty/failed board',
    r.success === true && r.dogs.length === 4, JSON.stringify(r).slice(0, 240));
  check('...and marks it stale so staff know', !!r.stale, `stale=${r.stale}`);
}

console.log('\n=== H. Cache isolation: meal periods and dates must not collide ===');
{
  const h = boot({ 'action=loadToday': [OK()], 'mode=checkinout': [CHECKIN()] });
  const lunch = h.api.getTodayPlan('Lunch');
  const morning = h.api.getTodayPlan('Morning Meal');
  check('Lunch and Breakfast do not share a cache entry',
    lunch.mealPeriod === 'Lunch' && morning.mealPeriod === 'Morning Meal',
    `${lunch.mealPeriod} / ${morning.mealPeriod}`);
  check('Breakfast did not inherit Lunch\'s dogs',
    JSON.stringify(morning.dogs) !== JSON.stringify(lunch.dogs), 'identical dog lists');
}
{
  // A last-known-good captured yesterday must never be served as today's plan.
  const h = boot({ 'action=loadToday': [OK()] });
  h.api.getTodayPlan('Lunch');
  h.state.now += 26 * 60 * 60 * 1000;                       // next day
  h.state.responses = { 'action=loadToday': [BAD(20000), BAD(20000), BAD(20000)] };
  const r = h.api.getTodayPlan('Lunch');
  const servedYesterday = (r.success === true && (r.dogs || []).length > 0 && r.today !== '2026-08-05');
  check('never serves YESTERDAY\'s plan as today\'s', !servedYesterday,
    `today=${r.today} dogs=${(r.dogs || []).length} stale=${r.stale}`);
}

console.log('\n=== I. Robustness: pen sheet and cache failures must not crash ===');
{
  const h = boot({ 'action=loadToday': [OK()] });
  h.state.penSheetThrows = true;
  let threw = false, r = null;
  try { r = h.api.getTodayPlan('Lunch'); } catch (e) { threw = true; }
  check('pen-sheet read failure does not throw to the client', !threw);
  check('...and returns a well-formed response', !!r && typeof r.success === 'boolean');
}
{
  const h = boot({ 'action=loadToday': [OK()] });
  h.state.cachePutFails = true;
  let threw = false, r = null;
  try { r = h.api.getTodayPlan('Lunch'); } catch (e) { threw = true; }
  check('CacheService failure does not throw to the client', !threw);
  check('...and the plan is still returned correctly',
    !!r && r.success === true && r.dogs.length === 4, JSON.stringify(r).slice(0, 200));
}
{
  // An oversized cache value (GAS caps a value at 100KB) must be survivable.
  const h = boot({ 'action=loadToday': [OK()] });
  h.state.cacheMaxValueBytes = 10;   // force every put to blow the cap
  let threw = false, r = null;
  try { r = h.api.getTodayPlan('Lunch'); } catch (e) { threw = true; }
  check('oversized cache value does not throw to the client', !threw);
  check('...and the plan is still correct',
    !!r && r.success === true && r.dogs.length === 4, JSON.stringify(r).slice(0, 200));
}

console.log('\n=== K. Review findings (P1/P2/P3) ===');
{
  // P1: a sheet with rows but nobody ticked "Lunch Y?" is a legitimate quiet day,
  // NOT an outage. It must never black out the button.
  const h = boot({ 'action=loadToday': [OK()] });
  const rows = penSheetFixture().map(r => r.slice());
  for (let i = 1; i < rows.length; i++) rows[i][11] = '';   // clear every Lunch Y? flag
  h.state.penSheetRows = rows;
  const r = h.api.getTodayPlan('Lunch');
  check('P1: zero "Lunch Y?" rows is a SUCCESS, not an outage', r.success === true,
    JSON.stringify(r).slice(0, 200));
  check('P1: ...with 0 dogs and the roster count intact for the tablet to explain',
    r.dogs.length === 0 && r.counts && r.counts.roster === 6,
    JSON.stringify(r.counts));
}
{
  // P2: an EMPTY last-known-good must not be served as a stale board — that would fire
  // the stale banner AND "no dogs found" together.
  const h = boot({ 'action=loadToday': [{ code: 200, body: JSON.stringify({ dogs: [] }) }, BAD(20000)] });
  const first = h.api.getTodayPlan('Lunch');
  check('P2: quiet day primes an empty LKG', first.success === true && first.dogs.length === 0);
  h.state.now += 5 * 60 * 1000;                       // expire FRESH, keep LKG
  const r = h.api.getTodayPlan('Lunch');
  check('P2: empty LKG is NOT served as a stale board', !(r.success === true && r.stale),
    JSON.stringify(r).slice(0, 200));
  check('P2: falls through to an honest error instead', r.success === false && !!r.error,
    JSON.stringify(r).slice(0, 200));
}
{
  // P3: fresh=1 must actually bypass the cache.
  const h = boot({ 'action=loadToday': [OK(), OK()] });
  h.api.getTodayPlan('Lunch');
  const afterFirst = h.state.fetchLog.length;
  h.api.getTodayPlan('Lunch');                        // cached
  check('P3: default second call still uses cache', h.state.fetchLog.length === afterFirst,
    `${afterFirst} -> ${h.state.fetchLog.length}`);
  h.api.getTodayPlan('Lunch', true);                  // forceFresh
  check('P3: fresh=1 bypasses the cache and refetches',
    h.state.fetchLog.length === afterFirst + 1,
    `${afterFirst} -> ${h.state.fetchLog.length}`);
}
{
  // P4: the whiteboard call must make exactly ONE upstream attempt (no retry storm).
  const h = boot({ 'action=loadToday': [BAD(2000), OK()] });
  h.api.getTodayPlan('Lunch');
  check('P4: whiteboard is called once per request, even on a fast failure',
    h.state.fetchLog.length === 1, `attempts=${h.state.fetchLog.length}`);
}

console.log('\n=== L. Direct Staff Board sheet read (primary roster source) ===');
{
  // Equivalence: the sheet path must produce exactly what the web-app path produced.
  const viaWeb = boot({ 'action=loadToday': [OK()] });
  const web = viaWeb.api.getTodayPlan('Lunch');

  const viaSheet = boot({ 'action=loadToday': [BAD(20000)] });   // web app dead on purpose
  viaSheet.state.boardRows = boardFixture();
  const sheet = viaSheet.api.getTodayPlan('Lunch');

  check('sheet read succeeds with the web app DEAD', sheet.success === true,
    JSON.stringify(sheet).slice(0, 200));
  check('sheet path made ZERO web-app calls', viaSheet.state.fetchLog.length === 0,
    `fetches=${viaSheet.state.fetchLog.length}`);
  check('sheet path reports rosterSource=sheet', sheet.rosterSource === 'sheet', sheet.rosterSource);
  check('sheet result is IDENTICAL to the web-app result',
    JSON.stringify(sheet.dogs) === JSON.stringify(web.dogs),
    `${JSON.stringify(sheet.dogs)} vs ${JSON.stringify(web.dogs)}`);
  check('...including skipped', JSON.stringify(sheet.skipped) === JSON.stringify(web.skipped),
    `${JSON.stringify(sheet.skipped)} vs ${JSON.stringify(web.skipped)}`);
  check('blank sheet row is skipped (roster count matches)',
    sheet.counts.roster === web.counts.roster, `${sheet.counts.roster} vs ${web.counts.roster}`);
}
{
  // Missing tab -> must NOT be created; falls back to the web app.
  const h = boot({ 'action=loadToday': [OK()] });
  h.state.boardRows = null;                       // tab absent
  let threw = false, r = null;
  try { r = h.api.getTodayPlan('Lunch'); } catch (e) { threw = true; }
  check('missing Today tab does not throw', !threw);
  check('missing Today tab falls back to the web app', r && r.rosterSource === 'webapp',
    r && r.rosterSource);
  check('...and still returns the right dogs', r && r.dogs.length === 4,
    r && JSON.stringify(r.dogs));
}
{
  // Unrecognised headers -> refuse to guess by position; fall back to the producer's reader.
  const h = boot({ 'action=loadToday': [OK()] });
  const rows = boardFixture();
  rows[0] = rows[0].map(() => 'x');               // header row wiped/renamed
  h.state.boardRows = rows;
  const r = h.api.getTodayPlan('Lunch');
  check('unrecognised headers do NOT get read positionally',
    r.rosterSource === 'webapp', r.rosterSource);
  check('...and the fallback still produces correct dogs', r.dogs.length === 4,
    JSON.stringify(r.dogs));
  check('...with the reason recorded for diagnosis',
    typeof r.rosterFallbackReason === 'string' && /header/i.test(r.rosterFallbackReason),
    String(r.rosterFallbackReason));
}
{
  // A re-ordered sheet must still read correctly — columns are resolved by NAME.
  const h = boot({ 'action=loadToday': [BAD(20000)] });
  const rows = boardFixture().map(r => r.slice());
  const moved = rows.map(r => {                    // insert a new column at the front
    const c = r.slice(); c.unshift(r === rows[0] ? 'New_Col' : 'junk'); return c;
  });
  h.state.boardRows = moved;
  const r = h.api.getTodayPlan('Lunch');
  check('a column inserted before Dog_Name does not break the read',
    r.success === true && r.dogs.length === 4, JSON.stringify(r).slice(0, 200));
  check('...still via the sheet, not the web app', r.rosterSource === 'sheet', r.rosterSource);
}
{
  // Sharing/permission failure on the workbook -> fall back, never crash.
  const h = boot({ 'action=loadToday': [OK()] });
  h.state.boardRows = boardFixture();
  h.state.boardSheetThrows = true;
  let threw = false, r = null;
  try { r = h.api.getTodayPlan('Lunch'); } catch (e) { threw = true; }
  check('a Staff Board access failure does not throw', !threw);
  check('...falls back to the web app', r && r.rosterSource === 'webapp', r && r.rosterSource);
}
{
  // BOTH sources down -> honest error, never an empty day.
  const h = boot({ 'action=loadToday': [BAD(20000)] });
  h.state.boardSheetThrows = true;
  const r = h.api.getTodayPlan('Lunch');
  check('both roster sources down => success:false', r.success === false, JSON.stringify(r).slice(0, 240));
  check('...error names BOTH failures', /sheet:/.test(r.error) && /web app:/.test(r.error),
    String(r.error).slice(0, 240));
}

console.log('\n=== M. addDog is IDEMPOTENT — a retried add must not duplicate the dog ===');
{
  // 2026-08-04: the tablet's queue retries an `add` after a client-side abort even when the
  // server landed the write. A blind appendRow duplicated the dog on every retry — the live
  // Session tab hit 37 rows for 16 dogs, and the TV display rendered every one of them.
  const h = load(BACKEND);
  h.state.sheets = h.state.sheets || {};
  const DOG = { id: 'dog_test_1', inputName: 'Milo McVey', matchedName: 'Milo McVey',
                status: 'all', penId: 'bottom-2', position: 1000 };

  const first = h.api.addDogToSession(DOG);
  const second = h.api.addDogToSession(DOG);        // the retry
  const third = h.api.addDogToSession(DOG);         // and another

  check('every add reports success', first.success && second.success && third.success,
    JSON.stringify([first, second, third]).slice(0, 200));
  check('the retries are flagged as deduped', second.deduped === true && third.deduped === true,
    `second=${second.deduped} third=${third.deduped}`);

  const state = h.api.getSessionState();
  const ids = (state.dogs || []).map(d => d.id);
  check('the dog appears EXACTLY ONCE', ids.filter(i => i === 'dog_test_1').length === 1,
    JSON.stringify(ids));
  check('session count is 1, not 3', state.count === 1, `count=${state.count}`);
}
{
  // A replayed add must REFRESH the row, not silently keep the older values — a retry can
  // legitimately carry a newer pen/position.
  const h = load(BACKEND);
  h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'all', penId: 'top-1', position: 1000 });
  h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'half', penId: 'top-3', position: 2000 });
  const s = h.api.getSessionState();
  const only = (s.dogs || [])[0];
  check('replay refreshed the row rather than duplicating', (s.dogs || []).length === 1,
    `${(s.dogs || []).length} rows`);
  check('...and the NEWER values won',
    !!only && only.penId === 'top-3' && only.status === 'half', JSON.stringify(only));
}
{
  // dedupeSession() repairs a tab that already accumulated duplicates.
  const h = load(BACKEND);
  const D = id => ({ id, inputName: 'Dog ' + id, status: 'all', penId: 'top-1', position: 1000 });
  h.api.addDogToSession(D('a'));
  h.api.addDogToSession(D('b'));
  // Force raw duplicates the way the old code would have, bypassing the idempotency check.
  const sheet = h.api.__sessionSheetForTest ? h.api.__sessionSheetForTest() : null;
  const before = h.api.getSessionState().count;
  const r = h.api.dedupeSession();
  check('dedupeSession is a safe no-op on a clean tab', r.success && r.removed === 0,
    JSON.stringify(r));
  check('...and leaves the dogs intact', h.api.getSessionState().count === before,
    `${before} -> ${h.api.getSessionState().count}`);
}

console.log('\n=== N. Session header self-heals in FULL, not just the Position column ===');
{
  // The live n8n `/cancel` branch clears the Session tab with a wholeSheet clear (verified on the
  // VPS 2026-08-05: the node has no `clear` parameter, so it defaults to wholeSheet), which takes
  // row 1 with it. GAS reads Session by INDEX so it never noticed; n8n's "Read Session (Status)"
  // node keys rows by row 1, so a wiped header makes it promote the first DOG row to headers.
  // Before 2026-08-05 only the Position cell was repaired, so the other 12 stayed wiped forever.
  const H = ['Dog_ID', 'Input_Name', 'Matched_Name', 'Possible_Matches', 'Status',
             'Prescription', 'Prescription_Comment', 'Supplements', 'Supplement_Types', 'Pen_ID',
             'Last_Updated', 'Meal_Type', 'Position'];

  {
    const h = load(BACKEND);
    h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'all', penId: 'top-1', position: 1000 });
    h.state.tabs.Session[0] = [];                       // n8n wholeSheet clear ate row 1
    h.api.ensureSessionTab();
    check('a fully wiped header is fully restored',
      JSON.stringify(h.state.tabs.Session[0]) === JSON.stringify(H),
      JSON.stringify(h.state.tabs.Session[0]));
  }
  {
    const h = load(BACKEND);
    h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'all', penId: 'top-1', position: 1000 });
    h.state.tabs.Session[0][0] = 'WRONG';                // an early header, not Position
    h.api.ensureSessionTab();
    check('drift in an EARLY column is repaired (the old code only checked Position)',
      h.state.tabs.Session[0][0] === 'Dog_ID', String(h.state.tabs.Session[0][0]));
  }
  {
    const h = load(BACKEND);
    h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'all', penId: 'top-1', position: 1000 });
    h.state.tabs.Session[0][12] = '';                    // the original Position-only case
    h.api.ensureSessionTab();
    check('the original Position repair still works', h.state.tabs.Session[0][12] === 'Position',
      String(h.state.tabs.Session[0][12]));
  }
  {
    const h = load(BACKEND);
    h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'all', penId: 'top-1', position: 1000 });
    const before = JSON.stringify(h.state.tabs.Session);
    h.api.ensureSessionTab();
    check('a healthy header is left completely alone (no needless write)',
      JSON.stringify(h.state.tabs.Session) === before);
  }
  {
    // Never let a hand-narrowed grid turn every endpoint into a 500.
    const h = load(BACKEND);
    h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'all', penId: 'top-1', position: 1000 });
    h.state.tabs.Session[0] = [];
    h.state.maxColumns = 5;                              // someone deleted columns
    let threw = false;
    try { h.api.ensureSessionTab(); } catch (e) { threw = true; }
    check('a too-narrow grid degrades to a no-op instead of throwing', threw === false);
    check('...and reads still work', h.api.getSessionState().success === true);
  }
  {
    // The repair must not disturb the dog rows underneath it.
    const h = load(BACKEND);
    h.api.addDogToSession({ id: 'd1', inputName: 'Leo', status: 'all', penId: 'top-1', position: 1000 });
    h.api.addDogToSession({ id: 'd2', inputName: 'Mac', status: 'half', penId: 'top-2', position: 2000 });
    h.state.tabs.Session[0] = [];
    h.api.ensureSessionTab();
    const s = h.api.getSessionState();
    check('dog rows survive the header repair', s.count === 2, `count=${s.count}`);
    check('...with their values intact',
      (s.dogs || []).map(d => d.id).sort().join(',') === 'd1,d2',
      JSON.stringify((s.dogs || []).map(d => d.id)));
  }
}

console.log('\n=== J. Unknown / missing mealPeriod unchanged ===');
{
  const h = boot({ 'action=loadToday': [OK()] });
  check('missing mealPeriod => success:false', h.api.getTodayPlan('').success === false);
  check('unknown mealPeriod => success:false', h.api.getTodayPlan('Brunch').success === false);
}

console.log(`\n================ ${pass} passed, ${fail} failed ================`);
if (failures.length) console.log('failed:\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
