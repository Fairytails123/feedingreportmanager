/**
 * LIVE contract test for the n8n session API (@36).
 *
 * WHY THIS EXISTS. Everything else in tests/ loads source files offline. The n8n workflow is not
 * a file in this repo — it lives on the VPS and is edited through the n8n MCP/editor, so nothing
 * in the offline gate can see it break. Two real bugs on 2026-08-05 proved that matters:
 *   - the Data Table node advertises a `table/clear` operation its RUNTIME ROUTER does not
 *     implement, so clearSession returned an empty body and silently left the board populated —
 *     and `n8n_validate_workflow` passed it clean;
 *   - the first sheet-mirror design raced itself and turned a 2-dog board into 6 duplicated rows.
 * Neither was catchable by validation. Both are caught here.
 *
 * RUN IT AFTER ANY CHANGE TO WORKFLOW hdGUbrd0PffVnwDS:
 *     LIVE=1 node tests/live_api.test.js
 *   (or  LIVE=1 bash tests/run.sh  to run it as part of the gate)
 *
 * SAFETY. It writes to the REAL board, so it refuses to run unless the board is empty — it will
 * never trample a feeding round in progress. It cleans up after itself and leaves the board
 * empty with mealType restored.
 */
'use strict';

const URL = 'https://auto.thefairytails.co.uk/webhook/feeding-session';
const TEST_PREFIX = 'livetest-';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail !== undefined ? ' — ' + detail : ''}`); fail++; }
}

async function call(body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error('non-JSON response: ' + text.slice(0, 200)); }
  } finally { clearTimeout(t); }
}

const dog = (id, over) => Object.assign({
  id: TEST_PREFIX + id, inputName: 'LiveTest ' + id, matchedName: 'LiveTest ' + id,
  status: 'all', penId: 'top-1', position: 1000,
  prescription: false, prescriptionComment: '', supplements: false,
  possibleMatches: [], supplementTypes: [],
}, over || {});

(async () => {
  console.log('\n=== LIVE n8n session API contract ===');
  console.log('    ' + URL);

  // ---- SAFETY GATE -------------------------------------------------------
  const before = await call({ action: 'getSession' });
  if (!before || before.success !== true) {
    console.error('\n  ABORT: could not read the live session — ' + JSON.stringify(before));
    process.exit(1);
  }
  const foreign = (before.dogs || []).filter(d => !String(d.id).startsWith(TEST_PREFIX));
  if (foreign.length) {
    console.error(`\n  ABORT: the live board has ${foreign.length} real dog(s) on it — a feeding`);
    console.error('  round is in progress. This test writes to the REAL board; refusing to run.');
    console.error('  Re-run when the board is empty.');
    process.exit(2);
  }
  const originalMeal = before.mealType;

  // ---- L1: the single-version-source invariant ---------------------------
  // Two different version sources can never compare equal, which pins every polling client in
  // permanent fast mode. This is the @29 lesson and it must hold across the n8n rewrite too.
  {
    await call({ action: 'addDog', dog: dog('v1') });
    const v = await call({ action: 'getSessionVersion' });
    const s = await call({ action: 'getSession' });
    check('getSessionVersion and getSession serve the SAME version',
      v.version === s.version, `${v.version} vs ${s.version}`);
    check('...and the same count', v.count === s.count, `${v.count} vs ${s.count}`);
    check('version is a positive number', typeof v.version === 'number' && v.version > 0, String(v.version));
  }

  // ---- L2: the write-response contract -----------------------------------
  // A mutation must NOT return `version`: the tablet's flushQueue does a guarded
  // `if (result.version) lastSyncVersion = result.version`, so returning it makes a device skip
  // remote edits it never applied. clearSession MUST return it — the tablet assigns that one
  // unguarded, and omitting it poisons the poll gate with undefined.
  {
    const add = await call({ action: 'addDog', dog: dog('v2') });
    const upd = await call({ action: 'updateDog', dogId: TEST_PREFIX + 'v2', updates: { status: 'half' } });
    const del = await call({ action: 'deleteDog', dogId: TEST_PREFIX + 'v2' });
    const meal = await call({ action: 'setMealType', mealType: 'Lunch' });
    check('addDog omits version', add.version === undefined, JSON.stringify(add));
    check('updateDog omits version', upd.version === undefined, JSON.stringify(upd));
    check('deleteDog omits version', del.version === undefined, JSON.stringify(del));
    check('setMealType omits version', meal.version === undefined, JSON.stringify(meal));
  }

  // ---- L3: version must actually advance on every write ------------------
  // If it does not, change-gated polling stalls and the TV silently shows a stale board.
  {
    const a = (await call({ action: 'getSessionVersion' })).version;
    await call({ action: 'addDog', dog: dog('v3') });
    const b = (await call({ action: 'getSessionVersion' })).version;
    await call({ action: 'updateDog', dogId: TEST_PREFIX + 'v3', updates: { status: 'quarter' } });
    const c = (await call({ action: 'getSessionVersion' })).version;
    await call({ action: 'deleteDog', dogId: TEST_PREFIX + 'v3' });
    const d = (await call({ action: 'getSessionVersion' })).version;
    check('version advances on add', b > a, `${a} -> ${b}`);
    check('version advances on update', c > b, `${b} -> ${c}`);
    check('version advances on DELETE', d > c, `${c} -> ${d}`);
  }

  // ---- L4: partial updates must not blank the rest of the row ------------
  // autoMapInputData writes only the keys present in the item. If that regresses to a full-row
  // write, two tablets editing different fields of one dog silently clobber each other.
  {
    await call({ action: 'addDog', dog: dog('v4', {
      penId: 'bottom-2', position: 7000, supplements: true, supplementTypes: ['joint'],
      prescription: true, prescriptionComment: 'half tablet',
    }) });
    await call({ action: 'updateDog', dogId: TEST_PREFIX + 'v4', updates: { status: 'none' } });
    const s = await call({ action: 'getSession' });
    const d = (s.dogs || []).find(x => x.id === TEST_PREFIX + 'v4');
    check('the changed field changed', d && d.status === 'none', d && d.status);
    check('penId survived a partial update', d && d.penId === 'bottom-2', d && d.penId);
    check('position survived', d && d.position === 7000, d && String(d.position));
    check('supplements survived', d && d.supplements === true, d && String(d.supplements));
    check('supplementTypes survived', d && JSON.stringify(d.supplementTypes) === '["joint"]',
      d && JSON.stringify(d.supplementTypes));
    check('prescriptionComment survived', d && d.prescriptionComment === 'half tablet',
      d && d.prescriptionComment);
  }

  // ---- L5: idempotency — the durable queue retries ambiguous writes ------
  // A client abort is indistinguishable from a failure even when the server landed the write.
  // A blind append here is what put 37 rows on the board for 16 dogs on 2026-08-04.
  {
    const d = dog('v5');
    await call({ action: 'addDog', dog: d });
    await call({ action: 'addDog', dog: d });
    await call({ action: 'addDog', dog: d });
    const s = await call({ action: 'getSession' });
    const n = (s.dogs || []).filter(x => x.id === TEST_PREFIX + 'v5').length;
    check('a replayed addDog leaves EXACTLY ONE row', n === 1, `${n} rows`);
    const del1 = await call({ action: 'deleteDog', dogId: TEST_PREFIX + 'v5' });
    const del2 = await call({ action: 'deleteDog', dogId: TEST_PREFIX + 'v5' });
    check('deleting an already-absent dog still succeeds',
      del1.success === true && del2.success === true, JSON.stringify([del1.success, del2.success]));
  }

  // ---- L6: clearSession actually clears -----------------------------------
  // The bug that shipped: `table/clear` validated fine and silently did nothing.
  {
    await call({ action: 'addDog', dog: dog('v6a') });
    await call({ action: 'addDog', dog: dog('v6b') });
    const cleared = await call({ action: 'clearSession' });
    const s = await call({ action: 'getSession' });
    check('clearSession RETURNS version (unlike mutations)', typeof cleared.version === 'number',
      JSON.stringify(cleared));
    check('clearSession EMPTIES the board', (s.dogs || []).length === 0,
      `${(s.dogs || []).length} left`);
    check('...and the version endpoint agrees', (await call({ action: 'getSessionVersion' })).count === 0);
  }

  // ---- L7: unknown actions fail loudly, not silently ----------------------
  {
    const r = await call({ action: 'definitelyNotAnAction' });
    check('unknown action returns success:false', r.success === false, JSON.stringify(r));
    check('...with a machine-readable code', r.code === 'UNKNOWN_ACTION', String(r.code));
    check('...marked non-retryable', r.retryable === false, String(r.retryable));
  }

  // ---- L8: latency — the entire reason this moved off Apps Script --------
  // Apps Script measured a 4.5-8.7s median with a 55.6s peak and ~40% of calls past the tablet's
  // 12s abort. If n8n ever drifts into that territory the migration has stopped paying for itself.
  {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      await call({ action: 'getSessionVersion' });
      times.push(Date.now() - t0);
    }
    const worst = Math.max(...times);
    const mean = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    check(`hot path stays fast (mean ${mean}ms, worst ${worst}ms)`, worst < 5000, `worst ${worst}ms`);
  }

  // ---- cleanup ------------------------------------------------------------
  await call({ action: 'clearSession' });
  if (originalMeal) await call({ action: 'setMealType', mealType: originalMeal });
  const end = await call({ action: 'getSession' });
  check('cleanup left the board empty', (end.dogs || []).length === 0, `${(end.dogs || []).length} left`);
  check('cleanup restored the meal type', end.mealType === originalMeal,
    `${end.mealType} vs ${originalMeal}`);

  console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n  LIVE TEST ERROR: ' + (e && e.message));
  process.exit(1);
});
