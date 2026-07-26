/**
 * FRM shared contract — the single source of truth for every value the tablet
 * (index.html), the TV display (display/display.html), and the GAS backend must
 * agree on. Introduced 2026-07-26 (phase 2 of the tablet+TV consolidation).
 *
 * How it is consumed:
 *  - The TV display: scripts/publish_display.ps1 INLINES this file into the
 *    published page (replacing the "// @@CONTRACT@@" marker) — the display defines
 *    none of these values itself.
 *  - The tablet: stays a single self-contained file (its inline copies are part of
 *    hand-balanced, live-proven code). scripts/check_contract.js asserts the
 *    tablet's inline values MATCH this file and fails the display publish if not.
 *
 * Change policy: change a value here FIRST, then update the tablet to match, then
 * publish the display. The backend's copies (penOrder/penRank in
 * feeding_report_backend_v2.js) are also asserted by check_contract.js.
 */

var FRM_CONTRACT = {
  // The GAS web-app /exec URL (deployment AKfycbwP74…, stable across clasp redeploys).
  // If this ever changes (a fresh `clasp deploy` minted a new URL — it shouldn't),
  // update it here and in index.html, then republish the display.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwP74AXOe1cZmHKTxi9KbMhZJU48EHRFI7NQ6Og65_FcTVB1sMQuqgkPKIkr7Fm7e40mw/exec',

  // Pen IDs in canonical feeding order. Hardcoded in the tablet (PEN_ORDER + the
  // submit-preview penOrder) and the backend (sendTelegramSummary penOrder +
  // submitReport penRank) — keep every copy identical.
  PEN_ORDER: ['top-1', 'top-2', 'top-3', 'top-4', 'top-5',
              'bottom-1', 'bottom-2', 'bottom-3', 'bottom-4', 'bottom-5'],

  // Feeding-status VALUE SET (Session `Status` column / dog.status). Display
  // glyphs are per-surface presentation (tablet shows "3/4", TV shows "¾") — only
  // the values are contract.
  STATUS_VALUES: ['all', 'three-quarter', 'half', 'quarter', 'none'],

  // Client-side GAS fetch timeout. The tablet's FETCH_TIMEOUT_MS uses the same
  // value; the backend's deleteDog lock wait (20s) is deliberately LONGER than
  // this so lock contention surfaces as a client abort, never a droppable
  // rejection (see CLAUDE.md "Session versioning is REAL now").
  FETCH_TIMEOUT_MS: 12000
};

/**
 * AbortController-wrapped fetch for GAS calls — a hung request aborts at
 * timeoutMs instead of dangling for minutes (the display had no timeout at all
 * before 2026-07-26). Same pattern as the tablet's gasFetch.
 *
 * TV-browser compatibility: the proven display page only ever used
 * async/await-era features, so anything newer degrades gracefully — no
 * AbortController → plain fetch (old behaviour, still works); no
 * Promise.finally → then/catch cleanup; no globalThis → window/self.
 */
function frmMakeGasFetch(timeoutMs) {
  var globalObj = (typeof window !== 'undefined') ? window
                : (typeof self !== 'undefined') ? self : this;
  var rawFetch = fetch.bind(globalObj);
  return function (url, opts) {
    if (typeof AbortController !== 'function') {
      return rawFetch(url, opts);
    }
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    var merged = Object.assign({}, opts || {}, { signal: controller.signal });
    var clear = function () { clearTimeout(timer); };
    var p = rawFetch(url, merged);
    p.then(clear, clear);
    return p;
  };
}

/**
 * Within-pen feeding order: stable sort by the Session `Position` column.
 * Legacy/0 positions tie, so server-row order is preserved — identical logic to
 * the tablet's applyRemoteState sort and the backend's submitReport fallback.
 */
function frmSortPenByPosition(dogsInPen) {
  return dogsInPen.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
}
