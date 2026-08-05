// Headless harness: loads the REAL inline <script> from an index.html and exposes
// the "Add Dogs for Today" path so it can be exercised against simulated GAS latency.
const fs = require('fs');

function makeEl(id) {
  return {
    id, value: '', textContent: '', disabled: false, innerHTML: '', style: {},
    className: '', dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }; },
    focus() {}, blur() {}, remove() {}, insertBefore() {}, closest() { return null; },
    getAttribute() { return null; }, setAttribute() {},
  };
}

function abortErr() {
  // Mirrors Chrome/Android's real message — exactly what staff saw on the tablet.
  const e = new Error('signal is aborted without reason');
  e.name = 'AbortError';
  return e;
}

function load(indexPath) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) throw new Error('no script block found in ' + indexPath);
  const src = html.slice(start + '<script>'.length, end);

  const els = {};
  const document = {
    getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement(t) { return makeEl('created-' + t); },
    addEventListener() {}, removeEventListener() {},
    body: makeEl('body'), documentElement: makeEl('html'), head: makeEl('head'),
    readyState: 'complete',
  };

  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
  };

  const state = { netPlan: [], netLog: [], confirmReturns: true, confirmMsgs: [] };

  function fakeFetch(url, opts) {
    const plan = state.netPlan.shift() || { delayMs: 5, body: { success: true, dogs: [] } };
    // Record the BODY too: since @36 the session calls are POSTs to the n8n webhook with the
    // action in the payload, so the URL alone no longer says what was asked for.
    let action = null;
    try { action = JSON.parse((opts && opts.body) || '{}').action || null; } catch (e) {}
    state.netLog.push({ url: String(url), delayMs: plan.delayMs, action });
    const signal = opts && opts.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: true, status: 200, json: async () => plan.body });
      }, plan.delayMs);
      if (signal) {
        if (signal.aborted) { clearTimeout(t); settled = true; return reject(abortErr()); }
        signal.addEventListener('abort', () => {
          if (settled) return;
          settled = true; clearTimeout(t); reject(abortErr());
        });
      }
    });
  }

  const win = {
    fetch: fakeFetch, document, localStorage,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    addEventListener() {}, removeEventListener() {},
    location: { href: 'https://fairytails123.github.io/feedingreportmanager/', search: '', reload() {} },
    navigator: { onLine: true, vibrate() {}, userAgent: 'harness' },
    alert() {}, confirm: (m) => { state.confirmMsgs.push(String(m)); return state.confirmReturns; }, prompt: () => null,
    innerWidth: 1024, innerHeight: 768,
    requestAnimationFrame: cb => setTimeout(cb, 0),
  };
  win.window = win;

  const sandbox = {
    window: win, document, localStorage, fetch: fakeFetch, console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    AbortController, Date, Math, JSON, Object, Array, String, Number, Boolean,
    Promise, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    navigator: win.navigator, alert: win.alert, confirm: win.confirm,
    location: win.location, requestAnimationFrame: win.requestAnimationFrame,
  };

  const EXPORTS = `
    return {
      gasFetch, addDogsForToday, computeMealPeriod, initPens,
      consts: {
        FETCH_TIMEOUT_MS: (typeof FETCH_TIMEOUT_MS !== 'undefined') ? FETCH_TIMEOUT_MS : null,
        PLAN_FETCH_TIMEOUT_MS: (typeof PLAN_FETCH_TIMEOUT_MS !== 'undefined') ? PLAN_FETCH_TIMEOUT_MS : null,
        PLAN_FETCH_ATTEMPTS: (typeof PLAN_FETCH_ATTEMPTS !== 'undefined') ? PLAN_FETCH_ATTEMPTS : null,
        SYNC_WRITE_TIMEOUT_MS: (typeof SYNC_WRITE_TIMEOUT_MS !== 'undefined') ? SYNC_WRITE_TIMEOUT_MS : null,
        PROBE_ATTEMPTS: (typeof PROBE_ATTEMPTS !== 'undefined') ? PROBE_ATTEMPTS : null,
      },
      flushQueue: (...a) => flushQueue(...a),
      submitToBackend: (...a) => submitToBackend(...a),
      loadDogList: (...a) => loadDogList(...a),
      get dogs() { return dogs; },
      get pens() { return pens; },
      get currentMealType() { return currentMealType; },

      // --- sync-loop surface (added 2026-08-05 for the version-first poll) ---
      pollForUpdates,
      syncState: {
        get isOnline() { return isOnline; },
        set isOnline(v) { isOnline = v; },
        get lastSyncVersion() { return lastSyncVersion; },
        set lastSyncVersion(v) { lastSyncVersion = v; },
        get initialLoadComplete() { return initialLoadComplete; },
        set initialLoadComplete(v) { initialLoadComplete = v; },
        get consecutiveFailures() { return consecutiveFailures; },
        get queue() { return mutationQueue; },
        set queue(v) { mutationQueue = v; },
        set lastDogListRefresh(v) { lastDogListRefresh = v; },
        pause() { pauseSync(); },
        unpause() { syncPausedUntil = 0; },
      },
      stub(o) {
        if (o.flushQueue) flushQueue = o.flushQueue;
        if (o.applyRemoteState) applyRemoteState = o.applyRemoteState;
        if (o.loadDogList) loadDogList = o.loadDogList;
        if (o.updateStatus) updateStatus = o.updateStatus;
        if (o.showToast) showToast = o.showToast;
        if (o.syncAddDog) syncAddDog = o.syncAddDog;
        if (o.syncMealType) syncMealType = o.syncMealType;
        if (o.renderAllPens) renderAllPens = o.renderAllPens;
        if (o.renderStagingArea) renderStagingArea = o.renderStagingArea;
        if (o.updateConnectionUI) updateConnectionUI = o.updateConnectionUI;
        if (o.pauseSync) pauseSync = o.pauseSync;
        if (o.matchDogName) matchDogName = o.matchDogName;
        if (o.fuzzyMatchDogName) fuzzyMatchDogName = o.fuzzyMatchDogName;
      },
    };
  `;

  const names = Object.keys(sandbox);
  const factory = new Function(...names, src + '\n' + EXPORTS);
  const api = factory(...names.map(n => sandbox[n]));

  return { api, state, els, srcLen: src.length };
}

module.exports = { load, abortErr };
