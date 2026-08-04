// Connection-health regression tests for the TV display.
// Assembles display/display.html (contract injected, exactly as published), evaluates its inline
// script with a minimal DOM, and drives the connection-health functions directly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; failures.push(name); }
}

// ---- assemble exactly what gets published -----------------------------------
const assembled = path.join(os.tmpdir(), 'frm_display_test_' + process.pid + '.html');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'assemble_display.js'), assembled]);
const html = fs.readFileSync(assembled, 'utf8');
try { fs.unlinkSync(assembled); } catch (e) {}

function boot() {
  // The page has more than one <script> block (the injected contract, then the app).
  // Concatenate every inline block in order — slicing first-open..last-close would swallow
  // the HTML sitting between them.
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  const src = blocks.join('\n;\n');

  const els = {};
  // NOTE: `className` and `classList` MUST share one backing store. The real code calls
  // `dot.className = 'refresh-dot'` to reset classes, and a stub that keeps them separate
  // reports a stale `classList.contains('error')` — which produced a false FAILURE here before
  // this was fixed. A harness that models the DOM loosely will lie in both directions.
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
      add: c => o._cls.add(c),
      remove: c => o._cls.delete(c),
      contains: c => o._cls.has(c),
      toggle: c => (o._cls.has(c) ? o._cls.delete(c) : o._cls.add(c)),
    };
    return o;
  })());

  const document = {
    getElementById: el,
    querySelector: () => null, querySelectorAll: () => [],
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

  const EXPORTS = `
    return {
      noteSuccess, noteFailure, setRefreshStatus,
      status: () => ({
        text: document.getElementById('statusText').textContent,
        dot: document.getElementById('refreshDot').className,
        error: document.getElementById('refreshDot').classList.contains('error'),
      }),
      bannerVisible: () => document.getElementById('staleBanner').classList.contains('visible'),
    };
  `;
  const names = Object.keys(sandbox);
  const api = new Function(...names, src + '\n' + EXPORTS)(...names.map(n => sandbox[n]));
  return { api, els };
}

console.log('\n=== D1. A successful poll must CLEAR a previous "Connection error" ===');
{
  // 2026-08-04: the pill was only cleared inside loadData()'s success path, and loadData only
  // runs when the version CHANGES. So one transient failure lit "Connection error" and, on a
  // quiet board, nothing ever turned it off while the probe kept succeeding every 10s.
  const { api } = boot();

  api.noteFailure('Connection error');
  const errored = api.status();
  check('a failure lights the error indicator', errored.error === true,
    JSON.stringify(errored));

  api.noteSuccess();                       // the version probe succeeding, board unchanged
  const after = api.status();
  check('a successful poll CLEARS the error indicator', after.error === false,
    JSON.stringify(after));
  check('...and the text no longer says "Connection error"',
    after.text !== 'Connection error', JSON.stringify(after));
}

console.log('\n=== D2. Failures still register (the indicator is not simply disabled) ===');
{
  const { api } = boot();
  api.noteSuccess();
  check('healthy state is not an error', api.status().error === false, JSON.stringify(api.status()));
  api.noteFailure('Connection error');
  check('a failure after a success still lights it', api.status().error === true,
    JSON.stringify(api.status()));
  api.noteFailure('Connection error');
  check('two consecutive failures raise the stale banner', api.bannerVisible() === true);
}

console.log('\n=== D3. Recovery clears the banner as well as the pill ===');
{
  const { api } = boot();
  api.noteFailure('Connection error');
  api.noteFailure('Connection error');
  check('banner up while disconnected', api.bannerVisible() === true);
  api.noteSuccess();
  check('banner cleared on recovery', api.bannerVisible() === false);
  check('pill cleared on recovery', api.status().error === false, JSON.stringify(api.status()));
}

console.log(`\n================ ${pass} passed, ${fail} failed ================`);
if (failures.length) console.log('failed:\n - ' + failures.join('\n - '));
process.exit(fail ? 1 : 0);
