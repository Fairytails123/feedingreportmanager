// Headless harness for the REAL feeding_report_backend_v2.js with Apps Script globals stubbed.
// Lets us replay getTodayPlan against a controllable, flaky upstream.
const fs = require('fs');

function load(backendPath, opts) {
  opts = opts || {};
  const src = fs.readFileSync(backendPath, 'utf8');

  const log = { warn: [], error: [], log: [] };
  const consoleStub = {
    warn: (...a) => log.warn.push(a.join(' ')),
    error: (...a) => log.error.push(a.join(' ')),
    log: (...a) => log.log.push(a.join(' ')),
    info: (...a) => log.log.push(a.join(' ')),
  };

  // ---- controllable upstream ------------------------------------------------
  // state.responses: { [urlSubstring]: [ {code, body, sleepMs} , ... ] }  (consumed in order,
  // last entry repeats once exhausted)
  const state = {
    responses: {},
    fetchLog: [],
    cache: {},            // script cache backing store: key -> {v, expires}
    now: Date.UTC(2026, 7, 4, 11, 0, 0),
    sleepTotal: 0,
    penSheetRows: null,
    penSheetThrows: false,
    boardRows: null,              // null => the "Today" tab is missing
    boardTabName: 'Today',
    boardSheetThrows: false,
    cachePutFails: false,
    cacheMaxValueBytes: 100 * 1024,   // real GAS per-value cap
    // Live tabs of the FEEDING workbook. Session starts with just its header row, exactly as the
    // real sheet does, so ensureSessionTab() finds it rather than re-creating it.
    tabs: {
      Session: [['Dog_ID', 'Input_Name', 'Matched_Name', 'Possible_Matches', 'Status',
                 'Prescription', 'Prescription_Comment', 'Supplements', 'Supplement_Types',
                 'Pen_ID', 'Last_Updated', 'Meal_Type', 'Position']],
      Temp: [['Dog Name', 'Parent Email', 'Meal', 'Food Consumed', 'Medicine Supplement',
              'Supplement Types', 'Comments']],
      Lookup: [['Dog Name', 'Parent Email', 'Parent Name']],
      Meta: [['Key', 'Value'], ['version', '1'], ['count', '0']],
    },
  };

  function pickResponse(url) {
    const keys = Object.keys(state.responses);
    for (const k of keys) {
      if (url.indexOf(k) !== -1) {
        const arr = state.responses[k];
        if (!arr || !arr.length) break;
        return arr.length > 1 ? arr.shift() : arr[0];
      }
    }
    return { code: 200, body: '{}' };
  }

  const UrlFetchApp = {
    fetch(url, params) {
      const r = pickResponse(String(url));
      state.fetchLog.push({ url: String(url), code: r.code, sleptMs: r.sleepMs || 0 });
      state.sleepTotal += (r.sleepMs || 0);
      state.now += (r.sleepMs || 0);
      if (r.throws) throw new Error(r.throws);
      return {
        getResponseCode: () => r.code,
        getContentText: () => r.body,
      };
    },
  };

  const Utilities = {
    sleep(ms) { state.sleepTotal += ms; state.now += ms; },
    formatDate(date, tz, fmt) {
      const d = new Date(date.getTime ? date.getTime() : date);
      const p = n => String(n).padStart(2, '0');
      if (fmt === 'yyyy-MM-dd') return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
      return d.toISOString();
    },
    getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
  };

  // A READ-ONLY sheet view over a fixed 2-D array (used for the pen / Staff Board fixtures).
  function makeSheet(name, gid, rows) {
    return {
      getName: () => name,
      getSheetId: () => gid,
      getDataRange: () => ({ getValues: () => rows }),
      getLastRow: () => rows.length,
      getLastColumn: () => (rows[0] ? rows[0].length : 0),
      getRange: () => ({
        getValues: () => rows, setValues() {}, setValue() {}, getValue: () => '',
        clearContent() {}, clear() {},
      }),
      clear() {}, clearContents() {}, deleteRows() {}, insertRowAfter() {},
      appendRow() {}, hideSheet() {}, setFrozenRows() {},
    };
  }

  // A MUTABLE sheet, backed by state.tabs — needed to test anything that writes (addDog,
  // updateDog, deleteDog, dedupeSession). Rows are a live 2-D array; ranges read and write
  // through to it, so a test can assert on what actually landed.
  function makeMutableSheet(name) {
    const grid = () => (state.tabs[name] || (state.tabs[name] = []));
    const cell = v => (v === undefined || v === null ? '' : v);
    return {
      getName: () => name,
      getSheetId: () => 0,
      getDataRange: () => ({
        getValues: () => grid().map(r => r.slice()),
        clearContent() { state.tabs[name] = []; },
      }),
      getLastRow: () => grid().length,
      getLastColumn: () => (grid()[0] ? grid()[0].length : 0),
      getMaxRows: () => Math.max(1, grid().length),
      // A real Sheets tab is 26 columns wide by default and only shrinks if someone deletes
      // columns by hand. state.maxColumns lets a test simulate exactly that.
      getMaxColumns: () => {
        if (state.maxColumns != null) return state.maxColumns;
        let w = 26;
        for (const r of grid()) if (r.length > w) w = r.length;
        return w;
      },
      getRange(row, col, numRows, numCols) {
        const nR = numRows || 1, nC = numCols || 1;
        return {
          getValues() {
            const out = [];
            for (let r = 0; r < nR; r++) {
              const src = grid()[(row - 1) + r] || [];
              const line = [];
              for (let c = 0; c < nC; c++) line.push(cell(src[(col - 1) + c]));
              out.push(line);
            }
            return out;
          },
          setValues(vals) {
            for (let r = 0; r < vals.length; r++) {
              const target = grid()[(row - 1) + r] || (grid()[(row - 1) + r] = []);
              for (let c = 0; c < vals[r].length; c++) target[(col - 1) + c] = vals[r][c];
            }
            return this;
          },
          getValue() { return cell((grid()[row - 1] || [])[col - 1]); },
          setValue(v) {
            const target = grid()[row - 1] || (grid()[row - 1] = []);
            target[col - 1] = v;
            return this;
          },
          clearContent() {
            for (let r = 0; r < nR; r++) {
              const target = grid()[(row - 1) + r];
              if (!target) continue;
              for (let c = 0; c < nC; c++) target[(col - 1) + c] = '';
            }
            return this;
          },
          clear() { return this.clearContent(); },
          setNumberFormat() { return this; }, setFontWeight() { return this; },
          setBackground() { return this; }, setHorizontalAlignment() { return this; },
        };
      },
      getParent: () => SpreadsheetApp.openById(FEEDING_SHEET),
      appendRow(row) { grid().push(row.slice()); },
      deleteRow(r) { grid().splice(r - 1, 1); },
      deleteRows(r, n) { grid().splice(r - 1, n || 1); },
      insertRowAfter() {},
      clear() { state.tabs[name] = []; },
      clearContents() { state.tabs[name] = []; },
      hideSheet() {}, setFrozenRows() {}, autoResizeColumn() {}, setColumnWidth() {},
    };
  }

  const PEN_SHEET = '1OD8SQR2WxgO0nncXwBKYAkNv-qAhw018CXaH4kWgTDU';
  const BOARD_SHEET = '1kQsNXeeyw-_XIw1MetkiR4D7Psyq-sUfxfWhF0DaoMs';
  const FEEDING_SHEET = '1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc';

  const SpreadsheetApp = {
    openById(id) {
      if (state.penSheetThrows && id === PEN_SHEET) {
        throw new Error('simulated openById failure');
      }
      if (id === BOARD_SHEET) {
        if (state.boardSheetThrows) throw new Error('simulated Staff Board access failure');
        const rows = state.boardRows;                    // null => tab missing
        return {
          getSheets: () => (rows ? [makeSheet('Today', 111, rows)] : []),
          getSheetByName: n => (rows && n === state.boardTabName) ? makeSheet(n, 111, rows) : null,
          insertSheet: () => { throw new Error('TEST FAIL: must never create a tab in another project\'s workbook'); },
        };
      }
      // The FEEDING workbook (Session / Temp / Lookup / Meta) — mutable, so writes are testable.
      if (id === FEEDING_SHEET || id === 'active') {
        return {
          getSheetByName: n => (state.tabs.hasOwnProperty(n) ? makeMutableSheet(n) : null),
          insertSheet: n => { state.tabs[n] = []; return makeMutableSheet(n); },
          getSheets: () => Object.keys(state.tabs).map(makeMutableSheet),
          getId: () => FEEDING_SHEET,
        };
      }
      const rows = state.penSheetRows || [['Dog Name']];
      return {
        getSheets: () => [makeSheet('Master', 0, rows)],
        getSheetByName: n => makeSheet(n, 1, rows),
        insertSheet: n => makeSheet(n, 2, [[]]),
      };
    },
    getActiveSpreadsheet() { return SpreadsheetApp.openById(FEEDING_SHEET); },
    flush() {},
  };

  const CacheService = {
    getScriptCache() {
      return {
        get(k) {
          const e = state.cache[k];
          if (!e) return null;
          if (e.expires <= state.now) { delete state.cache[k]; return null; }
          return e.v;
        },
        put(k, v, ttl) {
          if (state.cachePutFails) throw new Error('simulated cache failure');
          if (String(v).length > state.cacheMaxValueBytes) {
            throw new Error('Argument too large: value');
          }
          state.cache[k] = { v: String(v), expires: state.now + (ttl || 600) * 1000 };
        },
        remove(k) { delete state.cache[k]; },
      };
    },
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (opts.props && opts.props[k]) || '',
      setProperty() {}, deleteProperty() {},
    }),
  };

  const LockService = {
    getScriptLock: () => ({
      tryLock: () => true, waitLock() {}, releaseLock() {}, hasLock: () => true,
    }),
  };

  const FakeDate = new Proxy(Date, {
    construct(T, args) { return args.length ? new T(...args) : new T(state.now); },
    get(T, p) { return p === 'now' ? () => state.now : T[p]; },
  });

  const sandbox = {
    console: consoleStub, UrlFetchApp, Utilities, SpreadsheetApp, CacheService,
    PropertiesService, LockService, Date: FakeDate,
    JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    ContentService: {
      createTextOutput: t => ({ setMimeType: () => ({ getContent: () => t }), getContent: () => t }),
      MimeType: { JSON: 'json' },
    },
  };

  const EXPORTS = `
    return {
      getTodayPlan, getBoardingPlan_, getLunchPlan_, readPenMap_, fetchJson_, normName_,
      addDogToSession, getSessionState, dedupeSession, updateDogInSession, deleteDogFromSession,
      ensureSessionTab,
      CONFIG,
      has: n => { try { return typeof eval(n) === 'function'; } catch (e) { return false; } },
    };
  `;

  const names = Object.keys(sandbox);
  const api = new Function(...names, src + '\n' + EXPORTS)(...names.map(n => sandbox[n]));
  return { api, state, log };
}

// A representative master pen sheet.
function penSheetFixture() {
  const header = ['Dog Name', 'b', 'c', 'd', 'e', 'f', 'g', 'Last Name (Excel)',
                  'i', 'j', 'Feeding Pen Top (T) OR Bottom (B)', 'Lunch Y?'];
  const row = (dog, last, pen, lunch) => {
    const r = new Array(header.length).fill('');
    r[0] = dog; r[7] = last; r[10] = pen; r[11] = lunch;
    return r;
  };
  return [
    header,
    row('Betty McEwan', 'McEwan', 'T', 'Y'),
    row('Buddy Selby', 'Selby', 'B', 'Y'),
    row('Digby Shaw', 'Shaw', 'B', 'Y'),
    row('Narla Tester', 'Tester', 'B', 'Y'),
    row('George Elliston', 'Elliston', '', 'Y'),   // Lunch Y but no pen -> skipped
    row('Nolunch Dog', 'Nope', 'T', ''),           // pen but no Y -> excluded
  ];
}

function rosterFixture() {
  return JSON.stringify({
    dogs: [
      { name: 'Betty McEwan', serviceType: 'Full Day' },
      { name: 'Buddy Selby', serviceType: 'Half Day AM' },
      { name: 'Digby Shaw', serviceType: 'Boarding' },
      { name: 'Narla Tester', serviceType: 'Full Day' },
      { name: 'George Elliston', serviceType: 'Full Day' },
      { name: 'Nolunch Dog', serviceType: 'Full Day' },
    ],
  });
}

const ERROR_PAGE = '<!DOCTYPE html><html lang="en"><head><title>Page not found</title></head><body>Sorry, unable to open the file at this time.</body></html>';

// The REAL Staff Board "Today" header row, verified against the live sheet 2026-08-04.
const BOARD_HEADERS = ['ID', 'Dog_Name', 'Photo', 'Walk', 'Stop_AM', 'VP_AM', 'VP_PM', 'Stop',
  'Notes', 'Acuity_ID', 'Appointment_Type', 'Crate', 'Pickup', 'Dropoff', 'Van_Type',
  'Check_In', 'Check_Out', 'Crate_Size', 'Behaviour', 'Is_Grooming'];

// Same dogs and service types as rosterFixture(), so the sheet path and the web-app path are
// directly comparable — that equivalence is the whole point of the direct read.
function boardFixture() {
  const row = (id, name, type) => {
    const r = new Array(BOARD_HEADERS.length).fill('');
    r[0] = id; r[1] = name; r[10] = type;
    return r;
  };
  return [
    BOARD_HEADERS.slice(),
    row('dog_1', 'Betty McEwan', 'Full Day'),
    row('dog_2', 'Buddy Selby', 'Half Day AM'),
    row('dog_3', 'Digby Shaw', 'Boarding'),
    row('dog_4', 'Narla Tester', 'Full Day'),
    row('dog_5', 'George Elliston', 'Full Day'),
    row('dog_6', 'Nolunch Dog', 'Full Day'),
    row('', '', ''),                                  // blank row: must be skipped
  ];
}

module.exports = { load, penSheetFixture, rosterFixture, boardFixture, BOARD_HEADERS, ERROR_PAGE };
