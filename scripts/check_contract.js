/**
 * Contract drift-check — fails (exit 1) when any surface's inline copy of a
 * shared value diverges from shared/contract.js. Run by scripts/publish_display.sh
 * before every display publish; run it manually after editing the tablet or the
 * backend too:  node scripts/check_contract.js
 *
 * The tablet (index.html) deliberately keeps INLINE copies (it is a single
 * self-contained, live-proven file) — this script is the tripwire that keeps
 * those copies honest. The display defines NO copies (enforced below).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const contractSrc = read('shared/contract.js');
const tablet = read('index.html');
const backend = read('feeding_report_backend_v2.js');
const display = read('display/display.html');
const tvPlans = read('tv-plans/index.html');

// Evaluate the contract to get canonical values
const ctx = vm.createContext({});
vm.runInContext(contractSrc, ctx, { filename: 'shared/contract.js' });
const C = ctx.FRM_CONTRACT;

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('  OK    ' + label); }
  else { failures++; console.log('  DRIFT ' + label); }
}

console.log('== contract sanity ==');
check(C && typeof C.APPS_SCRIPT_URL === 'string' && /\/exec$/.test(C.APPS_SCRIPT_URL), 'contract exposes APPS_SCRIPT_URL (/exec)');
check(C && typeof C.SESSION_API_URL === 'string' && /^https:\/\/auto\.thefairytails\.co\.uk\/webhook\//.test(C.SESSION_API_URL), 'contract exposes SESSION_API_URL (n8n VPS webhook)');
check(Array.isArray(C.PEN_ORDER) && C.PEN_ORDER.length === 10, 'contract PEN_ORDER has 10 pens');
check(Array.isArray(C.STATUS_VALUES) && C.STATUS_VALUES.length === 5, 'contract STATUS_VALUES has 5 values');
check(typeof ctx.frmMakeGasFetch === 'function' && typeof ctx.frmSortPenByPosition === 'function', 'contract helpers present');

console.log('== tablet (index.html) matches contract ==');
check(tablet.includes(`const APPS_SCRIPT_URL = '${C.APPS_SCRIPT_URL}'`), 'tablet APPS_SCRIPT_URL identical');
check(tablet.includes(`const SESSION_API_URL = '${C.SESSION_API_URL}'`), 'tablet SESSION_API_URL identical');
// The whole point of @36: no session traffic may go back to Apps Script. These are the ONLY
// three GAS calls left, and each is a handful of requests a day rather than one per 5 seconds.
const gasCalls = (tablet.match(/APPS_SCRIPT_URL/g) || []).length;
check(gasCalls === 4, `tablet keeps exactly 3 GAS call sites + the const (found ${gasCalls} refs)`);
['getDogList', 'getTodayPlan', "action: 'submitReport'"].forEach(a =>
  check(tablet.includes(a), `tablet still calls GAS for ${a}`));
['getSessionVersion', 'getSession', 'clearSession'].forEach(a =>
  check(tablet.includes(`sessionFetch({ action: '${a}' }`), `tablet routes ${a} to n8n`));
check(tablet.includes(`const FETCH_TIMEOUT_MS = ${C.FETCH_TIMEOUT_MS}`), `tablet FETCH_TIMEOUT_MS = ${C.FETCH_TIMEOUT_MS}`);
const penListSingleLine = C.PEN_ORDER.map(p => `'${p}'`).join(', ');
check(tablet.includes(penListSingleLine), 'tablet submit-preview penOrder identical (single-line form)');
const penListWrapped = C.PEN_ORDER.slice(0, 5).map(p => `'${p}'`).join(', ');
check(tablet.includes(`const PEN_ORDER = [${penListWrapped},`), 'tablet PEN_ORDER starts with the canonical top row');
C.STATUS_VALUES.forEach(v => check(tablet.includes(`'${v}'`), `tablet knows status '${v}'`));

console.log('== backend (feeding_report_backend_v2.js) matches contract ==');
check(backend.includes(penListSingleLine) || backend.includes(C.PEN_ORDER.map(p => `'${p}'`).join(',')), 'backend penOrder/penRank identical');
C.STATUS_VALUES.forEach(v => check(backend.includes(`'${v}'`), `backend maps status '${v}'`));

console.log('== TV feeding plans matches boarding backend ==');
const tvPlansApiUrl = (tvPlans.match(/\bAPI_URL\s*=\s*(['"])([^'"]+)\1/) || [])[2];
const backendCheckinoutUrl = (backend.match(/\bCHECKINOUT_URL\s*:\s*(['"])([^'"]+)\1/) || [])[2];
check(tvPlansApiUrl !== undefined && tvPlansApiUrl === backendCheckinoutUrl, 'tv-plans/index.html API_URL identical to feeding_report_backend_v2.js CONFIG.CHECKINOUT_URL');
const tvPlansApiToken = (tvPlans.match(/\bAPI_TOKEN\s*=\s*(['"])([^'"]+)\1/) || [])[2];
const backendCheckinoutToken = (backend.match(/\bCHECKINOUT_TOKEN\s*:\s*(['"])([^'"]+)\1/) || [])[2];
check(tvPlansApiToken !== undefined && tvPlansApiToken === backendCheckinoutToken, 'tv-plans/index.html API_TOKEN identical to feeding_report_backend_v2.js CONFIG.CHECKINOUT_TOKEN');

console.log('== tablet medication plan matches TV and boarding backend ==');
const tabletPlansApiUrl = (tablet.match(/\bBOARDING_PLANS_API_URL\s*=\s*(['"])([^'"]+)\1/) || [])[2];
const tabletPlansApiToken = (tablet.match(/\bBOARDING_PLANS_API_TOKEN\s*=\s*(['"])([^'"]+)\1/) || [])[2];
check(tabletPlansApiUrl !== undefined && tabletPlansApiUrl === backendCheckinoutUrl, 'index.html BOARDING_PLANS_API_URL identical to feeding_report_backend_v2.js CONFIG.CHECKINOUT_URL');
check(tabletPlansApiUrl !== undefined && tabletPlansApiUrl === tvPlansApiUrl, 'index.html BOARDING_PLANS_API_URL identical to tv-plans/index.html API_URL');
check(tabletPlansApiToken !== undefined && tabletPlansApiToken === backendCheckinoutToken, 'index.html BOARDING_PLANS_API_TOKEN identical to feeding_report_backend_v2.js CONFIG.CHECKINOUT_TOKEN');
check(tabletPlansApiToken !== undefined && tabletPlansApiToken === tvPlansApiToken, 'index.html BOARDING_PLANS_API_TOKEN identical to tv-plans/index.html API_TOKEN');

console.log('== display (display/display.html) defines NO copies ==');
check(display.includes('// @@CONTRACT@@'), 'display has the @@CONTRACT@@ injection marker');
check(!display.includes('const APPS_SCRIPT_URL'), 'display does not define its own APPS_SCRIPT_URL');
check(!display.includes(C.APPS_SCRIPT_URL), 'display does not hardcode the exec URL');
check(!display.includes(C.SESSION_API_URL), 'display does not hardcode the n8n webhook URL');
check(display.includes('FRM_CONTRACT.SESSION_API_URL'), 'display reads the session from n8n via the contract');
check(!/APPS_SCRIPT_URL\s*\+\s*'\?action=/.test(display), 'display makes NO session calls to Apps Script');
check(!/pens\s*=\s*\{\s*'top-1'/.test(display), 'display builds pens from FRM_CONTRACT.PEN_ORDER, not a literal');
check(display.includes('FRM_CONTRACT.PEN_ORDER') && display.includes('frmSortPenByPosition') && display.includes('frmMakeGasFetch(FRM_CONTRACT.FETCH_TIMEOUT_MS)'), 'display consumes the contract helpers');
C.STATUS_VALUES.forEach(v => check(display.includes(`'${v}'`), `display STATUS_LABELS covers '${v}'`));

console.log(failures === 0 ? '\nCONTRACT OK' : `\nCONTRACT DRIFT: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
