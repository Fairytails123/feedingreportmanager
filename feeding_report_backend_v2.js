/**
 * Feeding Report Manager - Google Apps Script Backend
 * VERSION 2.1 - Real Versions + Write Locks Edition
 *
 * Sheet ID: 1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc
 * Tabs: Lookup (permanent), Session (real-time sync), Temp (submission staging),
 *       Meta (GAS-owned, hidden: real session version + row count for change-gated polling)
 *
 * TEMP TAB COLUMNS (7 columns):
 * Dog Name | Parent Email | Meal | Food Consumed | Medicine Supplement | Supplement Types | Comments
 *
 * SESSION TAB COLUMNS (13 columns):
 * Dog_ID | Input_Name | Matched_Name | Possible_Matches | Status | Prescription |
 * Prescription_Comment | Supplements | Supplement_Types | Pen_ID | Last_Updated | Meal_Type | Position
 * 
 * SETUP:
 * 1. Go to Google Sheet → Extensions → Apps Script
 * 2. Paste this entire code (replacing old version)
 * 3. Save (Ctrl+S)
 * 4. Create "Session" tab in your sheet with headers above
 * 5. Deploy → Manage deployments → Edit → New version → Deploy
 * 6. Copy the Web App URL for the website
 */

// ============================================
// CONFIGURATION
// ============================================

// ── Secrets via Script Properties (see CLAUDE.md "Secrets currently in source") ──
// The bot token is NOT stored inline. It lives in Apps Script → Project Settings →
// Script Properties (key TELEGRAM_BOT_TOKEN). _secret_() returns '' if the property is
// unset — the Telegram send sites then fail loud rather than building a malformed URL.
// To set/rotate: Project Settings → Script Properties (or PropertiesService.setProperty).
//
// ⚠️ Lazy by design (2026-07-26). PropertiesService must NOT be touched at global scope:
// GAS re-evaluates globals on EVERY web-app request, and Properties reads have a
// 50,000/day quota — a global read cost 1 per poll (~30k/day per always-on device) and
// could exhaust the quota mid-day, failing every endpoint at once for the rest of the
// day. _secret_() is called only inside the Telegram send paths (~1 read per submit).
function _secret_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

const CONFIG = {
  SHEET_ID: '1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc',
  LOOKUP_TAB: 'Lookup',
  SESSION_TAB: 'Session',
  TEMP_TAB: 'Temp',
  META_TAB: 'Meta',   // GAS-owned hidden tab: A2 = session version, B2 = session row count

  // TELEGRAM_BOT_TOKEN deliberately NOT read here — see the lazy _secret_() note above.
  // The send paths call _secret_('TELEGRAM_BOT_TOKEN') at send time.
  TELEGRAM_CHAT_ID: '-1003653235960',                   // group id — not a secret, left inline

  JOTFORM_ID: '240143730611039',

  // ── Whiteboard Display integration (for the "Add Dogs for Today" button) ──
  // These point at the separate Whiteboard project's GAS web apps. They are read
  // server-side via UrlFetchApp (no browser CORS). The URLs + token are already
  // public in the Pages-hosted whiteboard display, so this introduces no new secret.
  WHITEBOARD_TODAY_URL: 'https://script.google.com/macros/s/AKfycbzqXD9OCM5oSNFdy3OF7pOG0PRcpy4dgkEYWJBVh40CFHJgjvSpPn6SE-mNjloo-GKw/exec', // ?action=loadToday → today's daycare/boarding roster (lunch source)
  CHECKINOUT_URL: 'https://script.google.com/macros/s/AKfycbz2kc3lJbrGk7lw9jVcZMdUrPWjRx4qBARM8YVAIARhYAlQwCzlhHBbKswyOcVHytmB7Q/exec', // ?mode=checkinout&token=… → boarding stays w/ reliable dates (breakfast/dinner source)
  CHECKINOUT_TOKEN: 'ft-k9-board-2024-sec',

  // ── Lunch roster: read the Staff Board sheet DIRECTLY (2026-08-04) ──
  // WHY: WHITEBOARD_TODAY_URL above is a GAS web app that 404s for ~40% of requests under
  // load (it is shared with the TV display, the mobile editor and the Routes feed). The
  // underlying Today tab is owned by the same Google account as this script, so we can read
  // it with SpreadsheetApp directly and skip the failing web-app hop entirely — no new OAuth
  // scope (we already openById the master pen sheet). The web app stays as a FALLBACK.
  // ⚠️ READ-ONLY. This workbook belongs to the Whiteboard project. Never create the tab,
  // never write. If the tab is missing that is an error to report, not a thing to fix.
  // Columns are resolved by HEADER NAME (`Dog_Name`, `Appointment_Type`); if the header
  // cannot be resolved we do NOT guess by position — we fall back to the web app, which runs
  // the producer's own reader and its own fallback logic.
  STAFF_BOARD_SHEET_ID: '1kQsNXeeyw-_XIw1MetkiR4D7Psyq-sUfxfWhF0DaoMs',   // "Fairy Tails Staff Board"
  STAFF_BOARD_TODAY_TAB: 'Today',

  // ── "Add Dogs for Today" resilience (2026-08-04) ──
  // Measured live: WHITEBOARD_TODAY_URL returns HTTP 404 + a Google "Page not found"
  // page for ~40% of requests (8–43s to fail), and even a SUCCESS takes 2–24s. Before
  // this, a failed read became `dogs: []` with `success: true`, so staff were told
  // "No Lunch dogs found on the whiteboard for today" during an outage — indistinguishable
  // from a genuinely empty day, and they hand-built the board instead.
  // Defence in depth, most valuable first:
  //   1. FRESH cache      — most presses never touch the flaky upstream at all.
  //   2. LAST-KNOWN-GOOD  — an outage still yields a usable board, clearly marked stale.
  //   3. bounded retry    — rescues the cheap transient failure only (see fetchJson_).
  PLAN_CACHE_FRESH_SEC: 120,      // short: a whiteboard edit must show up quickly
  // 45 min, NOT the 6h cap. A lunch roster six hours old is a different day's service: dogs
  // have gone home, "Lunch Y?" has been re-ticked. Because the tablet MERGES a plan onto the
  // board and never removes, an over-long horizon can put a dog that left back into a live
  // feeding round — which ends in a JotForm report and a parent email for a dog that wasn't
  // there. 45 min covers a genuine outage without spanning a service change.
  PLAN_CACHE_LKG_SEC: 2700,
  PLAN_FETCH_ATTEMPTS: 2,
  PLAN_FETCH_DEADLINE_MS: 8000,   // only retry a failure that came back fast

  // ── Pen-assignment source (master "Jot form Dog Details" sheet) ──
  // Lunch Top/Bottom side now lives in the shared master sheet, column K, NOT in a
  // dedicated tab of the feeding sheet (the old BT_PEN_GID tab is retired). We own
  // this sheet, so SpreadsheetApp.openById works directly. readPenMap_ resolves the
  // pen column by header text ("feeding pen"), falling back to PEN_COL_FALLBACK_INDEX.
  PEN_SHEET_ID: '1OD8SQR2WxgO0nncXwBKYAkNv-qAhw018CXaH4kWgTDU',  // "Jot form Dog Details"
  PEN_TAB_GID: 0,               // Master tab
  PEN_COL_FALLBACK_INDEX: 10,   // column K = "Feeding Pen Top (T) OR Bottom (B)" (A=0 … K=10)
  LUNCH_COL_FALLBACK_INDEX: 11, // column L = "Lunch Y?"  (Y ⇒ this dog is added to a lunch pen)
  LASTNAME_COL_FALLBACK_INDEX: 7, // column H = "Last Name (Excel)" (owner surname; used by the name-join fallback)
  
  // JotForm Unique Names (required for URL pre-fill)
  JOTFORM_FIELDS: {
    DATE_DAY: 'date[day]',
    DATE_MONTH: 'date[month]',
    DATE_YEAR: 'date[year]',
    DOG_NAME: 'myName',
    PARENT_EMAIL: 'myEmail',
    MEAL_TIME: 'mealTime',
    FOOD_CONSUMED: 'typeA',
    HAS_MEDICINE_SUPPLEMENT: 'medicineAndor',
    MEDICINE_SUPPLEMENTS: 'medicineAnd',
    ADDITIONAL_COMMENTS: 'additionalComments'
  },
  
  // Session column indices (0-based)
  SESSION_COLS: {
    DOG_ID: 0,
    INPUT_NAME: 1,
    MATCHED_NAME: 2,
    POSSIBLE_MATCHES: 3,
    STATUS: 4,
    PRESCRIPTION: 5,
    PRESCRIPTION_COMMENT: 6,
    SUPPLEMENTS: 7,
    SUPPLEMENT_TYPES: 8,
    PEN_ID: 9,
    LAST_UPDATED: 10,
    MEAL_TYPE: 11,
    POSITION: 12   // within-pen feeding order (numeric, dense index*1000)
  },
  
  // Temp tab has 7 columns (no Parent Name)
  TEMP_COLUMNS: 7,

  // Canonical Temp-tab header (row 1). Single source of truth — n8n's "Read Temp Tab"
  // node keys each row by row 1, so this row MUST exist or n8n promotes the first dog
  // row to headers and `Has Data?` ($json['Dog Name']) fails for every row.
  TEMP_HEADER: ['Dog Name', 'Parent Email', 'Meal', 'Food Consumed', 'Medicine Supplement', 'Supplement Types', 'Comments']
};

// ============================================
// WEB APP ENTRY POINTS
// ============================================

/**
 * Handle GET requests
 */
function doGet(e) {
  try {
    const action = e.parameter.action;
    
    let result;
    
    switch (action) {
      case 'getDogList':
        result = getDogList();
        break;
      case 'getSession':
        result = getSessionState();
        break;
      case 'getSessionVersion':
        result = getSessionVersion();
        break;
      case 'getTodayPlan':
        result = getTodayPlan(e.parameter.mealPeriod, e.parameter.fresh === '1');
        break;
      case 'repairTemp':
        result = repairTemp();
        break;
      default:
        // A bare /exec (no action) is the deployment ping — keep it success:true, it is the
        // documented smoke check. But an action that was ASKED FOR and isn't recognised is an
        // error: answering success:true let a frontend deployed ahead of the backend read as
        // a quiet, empty day instead of a version mismatch (2026-08-04). doPost already does this.
        result = action
          ? { success: false, error: 'Unknown action: ' + action }
          // ⚠️ BUMP THIS STRING ON EVERY DEPLOY. It is the documented way to confirm which code
          // is serving, and it silently went stale across @30/@31/@32 while behaviour changed.
          : { success: true, status: 'ok', message: 'Feeding Report API v2.3 - Direct Staff Board Read + Plan Cache' };
    }
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handle POST requests from website
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    
    let result;
    
    switch (action) {
      case 'getDogList':
        result = getDogList();
        break;
      case 'getSession':
        result = getSessionState();
        break;
      case 'addDog':
        result = addDogToSession(data.dog);
        break;
      case 'updateDog':
        result = updateDogInSession(data.dogId, data.updates);
        break;
      case 'deleteDog':
        result = deleteDogFromSession(data.dogId);
        break;
      case 'setMealType':
        result = setSessionMealType(data.mealType);
        break;
      case 'submitReport':
        result = submitReport(data);
        break;
      case 'clearSession':
        result = clearSession();
        break;
      case 'getTemp':
        result = getTempData();
        break;
      case 'clearTemp':
        result = clearTempTab();
        break;
      case 'getTodayPlan':
        result = getTodayPlan(data.mealPeriod, data.fresh === true || data.fresh === '1');
        break;
      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================
// SESSION MANAGEMENT (Real-Time Sync)
// ============================================

/**
 * Ensure Session tab exists with proper headers
 */
function ensureSessionTab() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SESSION_TAB);
  
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SESSION_TAB);
    sheet.appendRow([
      'Dog_ID', 'Input_Name', 'Matched_Name', 'Possible_Matches', 'Status',
      'Prescription', 'Prescription_Comment', 'Supplements', 'Supplement_Types', 'Pen_ID',
      'Last_Updated', 'Meal_Type', 'Position'
    ]);
    sheet.setFrozenRows(1);
  } else if (sheet.getRange(1, CONFIG.SESSION_COLS.POSITION + 1).getValue() !== 'Position') {
    // Self-heal: the Position column (M) was added after this tab already existed. Mirrors
    // ensureTempHeader_ — set the header so getSessionState/updateDogInSession map column 13 cleanly.
    sheet.getRange(1, CONFIG.SESSION_COLS.POSITION + 1).setValue('Position');
  }

  return sheet;
}

// ============================================
// SESSION VERSION META (real change detection)
// ============================================
// Before 2026-07-26 getSessionState returned version = Date.now() (always fresh), so no
// polling client could ever gate on "did anything change" — and the TV display's adaptive
// refresh oscillated permanently because getSession's fake version never matched
// getSessionVersion's real one. The Meta tab fixes this: a single monotonic version
// (A2) + the session row count (B2), bumped INSIDE every mutation's lock. Both read
// endpoints return the same value, so clients can skip work when nothing changed.
//
// Out-of-band edits (n8n /cancel's whole-sheet Session clear, a manual row add/delete in
// the Sheets UI) don't go through these mutators — the reads self-heal: when the actual
// row count drifts from Meta's stored count, the version is bumped so every client
// refetches. (An in-place cell edit made directly in the Sheets UI does not change the
// count and is NOT detected — any tablet edit afterwards propagates it.)

/** Ensure the hidden Meta tab exists. Row 1 header, row 2 = [version, count]. */
function ensureMetaTab_(ss) {
  let sheet = ss.getSheetByName(CONFIG.META_TAB);
  if (!sheet) {
    // Reads reach here unlocked, so two first-requests can race the null check —
    // the loser's insertSheet throws "already exists"; recover by re-getting. If the
    // rival hasn't seeded row 2 yet, readMeta_ sees version 0 and self-heal mints one.
    try {
      sheet = ss.insertSheet(CONFIG.META_TAB);
      sheet.getRange(1, 1, 1, 3).setValues([['Session_Version', 'Session_Count', 'GAS-owned — do not edit']]);
      sheet.getRange(2, 1, 1, 2).setValues([[new Date().getTime(), 0]]);
      try { sheet.hideSheet(); } catch (e) { /* hiding is cosmetic — never fail a request over it */ }
    } catch (e) {
      sheet = ss.getSheetByName(CONFIG.META_TAB);
      if (!sheet) throw e;
    }
  }
  return sheet;
}

/** Read the stored session version + count from Meta. */
function readMeta_(ss) {
  const sheet = ensureMetaTab_(ss);
  const vals = sheet.getRange(2, 1, 1, 2).getValues()[0];
  return { version: Number(vals[0]) || 0, count: Number(vals[1]) || 0 };
}

/**
 * Advance the session version and store the current row count.
 * Monotonic even under same-millisecond writes (max(now, stored+1)).
 * Call only while holding the script lock (mutators) or the tryLock in
 * currentSessionVersion_'s self-heal path.
 */
function bumpSessionVersion_(ss, actualCount) {
  const sheet = ensureMetaTab_(ss);
  const stored = Number(sheet.getRange(2, 1).getValue()) || 0;
  const version = Math.max(new Date().getTime(), stored + 1);
  sheet.getRange(2, 1, 1, 2).setValues([[version, actualCount]]);
  return version;
}

/**
 * Best-effort bump for use AFTER an irreversible sheet mutation has already landed.
 * A thrown bump must never fail the request: the tablet's queue would retry the op and
 * (for add) append a DUPLICATE row. A missed bump on add/delete self-heals via the
 * count-drift path; on update/setMealType it merely delays propagation until the next
 * mutation — both strictly better than rejecting a write that already happened.
 */
function tryBumpSessionVersion_(ss, actualCount) {
  try {
    return bumpSessionVersion_(ss, actualCount);
  } catch (e) {
    console.warn('[tryBumpSessionVersion_] bump failed after a landed mutation — relying on drift self-heal: ' + e);
    return null;
  }
}

/** Count real session rows (non-empty Dog_ID) — the same predicate getSessionState uses. */
function countSessionRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  const ids = sheet.getRange(2, CONFIG.SESSION_COLS.DOG_ID + 1, lastRow - 1, 1).getValues();
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0]) n++;
  }
  return n;
}

/**
 * The version both read endpoints return. Self-heals out-of-band count drift under a
 * NON-BLOCKING lock: if a mutation currently holds the lock it will bump the version
 * itself, so the read just returns the stored value and lets the next poll converge.
 */
function currentSessionVersion_(ss, actualCount) {
  const meta = readMeta_(ss);
  if (meta.version && meta.count === actualCount) {
    return meta.version;
  }
  const lock = LockService.getScriptLock();
  if (lock.tryLock(0)) {
    try {
      return bumpSessionVersion_(ss, actualCount);
    } finally {
      lock.releaseLock();
    }
  }
  return meta.version || 1;  // never 0/falsy — clients truthy-check version
}

/**
 * Serialize a mutation under the script lock. Closes the cross-device row-shift race:
 * locate-row + write + version bump happen atomically, so a concurrent add/delete can't
 * shift an update onto the wrong dog's row. A lock timeout surfaces as an op-level
 * rejection ({success:false}), which the tablet's queue already retries.
 * NOTE: locks serialize GAS executions only — n8n's own Sheets writes bypass them
 * (covered by the count-drift self-heal above).
 */
function withScriptLock_(label, fn, waitMs) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(waitMs || 10000);
  } catch (e) {
    return { success: false, error: 'Server busy, please retry (' + label + ')' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Safely parse a JSON string, returning a fallback value if parsing fails.
 * Prevents a single corrupted cell in Google Sheets from crashing the entire
 * getSessionState() function and breaking all devices.
 */
function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    // Log the error for debugging but don't crash
    console.warn('[safeJsonParse] Failed to parse: "' + value + '" — returning fallback. Error: ' + e.toString());
    return fallback;
  }
}

/**
 * Get current session state (all dogs + pen assignments + meal type)
 * This is called by all devices to sync their state
 */
function getSessionState() {
  try {
    const sheet = ensureSessionTab();
    const ss = sheet.getParent();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return {
        success: true,
        dogs: [],
        mealType: 'Lunch',
        version: currentSessionVersion_(ss, 0),
        count: 0
      };
    }
    
    const dogs = [];
    let mealType = 'Lunch';
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[CONFIG.SESSION_COLS.DOG_ID]) continue;
      
      // Get meal type from first dog (all should be same)
      if (row[CONFIG.SESSION_COLS.MEAL_TYPE]) {
        mealType = row[CONFIG.SESSION_COLS.MEAL_TYPE];
      }
      
      dogs.push({
        id: row[CONFIG.SESSION_COLS.DOG_ID],
        inputName: row[CONFIG.SESSION_COLS.INPUT_NAME] || '',
        matchedName: row[CONFIG.SESSION_COLS.MATCHED_NAME] || null,
        // DEFENSIVE PARSE FIX: Wrap JSON.parse in try-catch so a single corrupted
        // row doesn't crash getSessionState() for ALL dogs
        possibleMatches: safeJsonParse(row[CONFIG.SESSION_COLS.POSSIBLE_MATCHES], []),
        status: row[CONFIG.SESSION_COLS.STATUS] || 'all',
        prescription: row[CONFIG.SESSION_COLS.PRESCRIPTION] === 'true' || row[CONFIG.SESSION_COLS.PRESCRIPTION] === true,
        prescriptionComment: row[CONFIG.SESSION_COLS.PRESCRIPTION_COMMENT] || '',
        supplements: row[CONFIG.SESSION_COLS.SUPPLEMENTS] === 'true' || row[CONFIG.SESSION_COLS.SUPPLEMENTS] === true,
        // DEFENSIVE PARSE FIX: Same protection for supplementTypes
        supplementTypes: safeJsonParse(row[CONFIG.SESSION_COLS.SUPPLEMENT_TYPES], []),
        penId: row[CONFIG.SESSION_COLS.PEN_ID] || null,
        lastUpdated: row[CONFIG.SESSION_COLS.LAST_UPDATED],
        // Within-pen feeding order. Legacy rows have no column M -> undefined -> 0 (all tie, so the
        // client's stable sort preserves server-row order until the first reorder backfills positions).
        position: Number(row[CONFIG.SESSION_COLS.POSITION]) || 0
      });
    }
    
    // Real version from the Meta tab (bumped by every mutation) — identical to what
    // getSessionVersion returns, so polling clients can gate on it. The count uses the
    // same non-empty-Dog_ID predicate as getSessionVersion (keep them aligned: the TV
    // display compares version AND count across the two endpoints).
    return {
      success: true,
      dogs: dogs,
      mealType: mealType,
      version: currentSessionVersion_(ss, dogs.length),
      count: dogs.length
    };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Get just the version (for efficient change-gated polling).
 * Returns the SAME Meta-tab version as getSessionState — never a per-request timestamp.
 */
function getSessionVersion() {
  try {
    const sheet = ensureSessionTab();
    const ss = sheet.getParent();
    const count = countSessionRows_(sheet);
    return { success: true, version: currentSessionVersion_(ss, count), count: count };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Add a new dog to the session
 *
 * ⚠️ Write-response contract (2026-07-26): add/update/delete/setMealType responses
 * deliberately carry NO `version` field. The tablet's flushQueue only advances
 * lastSyncVersion when a response has one — omitting it keeps lastSyncVersion at the
 * last APPLIED snapshot, so the poll after a queue flush still fetches any remote edits
 * made while this device was offline. clearSession is the one write that keeps
 * `version` (the tablet's syncClearSession assigns result.version unguarded).
 */
function addDogToSession(dog) {
  return withScriptLock_('addDog', function () { return addDogToSessionCore_(dog); });
}

function addDogToSessionCore_(dog) {
  try {
    const sheet = ensureSessionTab();
    const timestamp = new Date().getTime();

    const row = [
      dog.id,
      dog.inputName,
      dog.matchedName || '',
      JSON.stringify(dog.possibleMatches || []),
      dog.status || 'all',
      dog.prescription ? 'true' : 'false',
      dog.prescriptionComment || '',
      dog.supplements ? 'true' : 'false',
      JSON.stringify(dog.supplementTypes || []),
      dog.penId || '',
      timestamp,
      dog.mealType || 'Lunch',
      (typeof dog.position === 'number' ? dog.position : 0)
    ];

    sheet.appendRow(row);
    tryBumpSessionVersion_(sheet.getParent(), countSessionRows_(sheet));

    return {
      success: true,
      dogId: dog.id,
      message: 'Dog added to session'
    };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Update an existing dog in the session
 * Locked: the row locate + writes are atomic vs concurrent add/delete (row-shift race).
 */
function updateDogInSession(dogId, updates) {
  return withScriptLock_('updateDog', function () { return updateDogInSessionCore_(dogId, updates); });
}

function updateDogInSessionCore_(dogId, updates) {
  try {
    const sheet = ensureSessionTab();
    const data = sheet.getDataRange().getValues();
    const timestamp = new Date().getTime();
    
    // Find the dog's row
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][CONFIG.SESSION_COLS.DOG_ID] == dogId) {
        rowIndex = i + 1; // 1-based for sheet
        break;
      }
    }
    
    if (rowIndex === -1) {
      return { success: false, error: 'Dog not found in session: ' + dogId };
    }
    
    // Update specific fields
    if (updates.matchedName !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.MATCHED_NAME + 1).setValue(updates.matchedName || '');
    }
    if (updates.status !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.STATUS + 1).setValue(updates.status);
    }
    if (updates.prescription !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.PRESCRIPTION + 1).setValue(updates.prescription ? 'true' : 'false');
    }
    if (updates.prescriptionComment !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.PRESCRIPTION_COMMENT + 1).setValue(updates.prescriptionComment);
    }
    if (updates.supplements !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.SUPPLEMENTS + 1).setValue(updates.supplements ? 'true' : 'false');
    }
    if (updates.supplementTypes !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.SUPPLEMENT_TYPES + 1).setValue(JSON.stringify(updates.supplementTypes));
    }
    if (updates.penId !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.PEN_ID + 1).setValue(updates.penId || '');
    }
    if (updates.position !== undefined) {
      sheet.getRange(rowIndex, CONFIG.SESSION_COLS.POSITION + 1).setValue(updates.position);
    }

    // Always update timestamp
    sheet.getRange(rowIndex, CONFIG.SESSION_COLS.LAST_UPDATED + 1).setValue(timestamp);
    tryBumpSessionVersion_(sheet.getParent(), countSessionRows_(sheet));

    return {
      success: true,
      dogId: dogId,
      message: 'Dog updated'
    };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Delete a dog from the session
 * Locked: the row locate + deleteRow are atomic vs concurrent writes. The version bump
 * on delete matters doubly — max(Last_Updated) never rose on a delete, which is one of
 * the reasons the old always-fresh version could never be made real without Meta.
 */
function deleteDogFromSession(dogId) {
  // waitMs 20000 (> the tablet's 12s gasFetch abort) on purpose: the live tablet
  // dequeues ANY success:false delete as "row already gone", so a 10s lock-timeout
  // rejection would silently drop the delete and the dog would resurrect. With a
  // 20s wait, contention makes the CLIENT abort instead (network failure → op kept
  // and retried), and if this execution still completes the delete, the retry's
  // "Dog not found" correctly resolves to done.
  return withScriptLock_('deleteDog', function () { return deleteDogFromSessionCore_(dogId); }, 20000);
}

function deleteDogFromSessionCore_(dogId) {
  try {
    const sheet = ensureSessionTab();
    const data = sheet.getDataRange().getValues();

    // Find and delete the dog's row
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][CONFIG.SESSION_COLS.DOG_ID] == dogId) {
        sheet.deleteRow(i + 1);
        tryBumpSessionVersion_(sheet.getParent(), countSessionRows_(sheet));
        return {
          success: true,
          dogId: dogId,
          message: 'Dog removed from session'
        };
      }
    }

    return { success: false, error: 'Dog not found: ' + dogId };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Set the meal type for the entire session
 * Locked: the getLastRow snapshot + the two column writes are atomic vs concurrent
 * add/delete, so the ranges can't be sized against a stale row count.
 */
function setSessionMealType(mealType) {
  return withScriptLock_('setMealType', function () { return setSessionMealTypeCore_(mealType); });
}

function setSessionMealTypeCore_(mealType) {
  try {
    const sheet = ensureSessionTab();
    const lastRow = sheet.getLastRow();
    const timestamp = new Date().getTime();
    
    if (lastRow > 1) {
      // Update meal type for all dogs
      const range = sheet.getRange(2, CONFIG.SESSION_COLS.MEAL_TYPE + 1, lastRow - 1, 1);
      const values = [];
      for (let i = 0; i < lastRow - 1; i++) {
        values.push([mealType]);
      }
      range.setValues(values);
      
      // Update timestamps
      const timeRange = sheet.getRange(2, CONFIG.SESSION_COLS.LAST_UPDATED + 1, lastRow - 1, 1);
      const timeValues = [];
      for (let i = 0; i < lastRow - 1; i++) {
        timeValues.push([timestamp]);
      }
      timeRange.setValues(timeValues);
    }

    tryBumpSessionVersion_(sheet.getParent(), countSessionRows_(sheet));

    return {
      success: true,
      mealType: mealType,
      message: 'Meal type updated'
    };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Clear the entire session (only called after submission or explicit clear)
 * The ONE write whose response keeps `version`: the tablet's syncClearSession assigns
 * result.version to lastSyncVersion unguarded, so omitting it would poison the poll
 * gate with undefined. Returning the bump is safe — after a clear, local and server
 * state are both empty, so "up to date as of this version" is true.
 */
function clearSession() {
  return withScriptLock_('clearSession', function () { return clearSessionCore_(); });
}

function clearSessionCore_() {
  try {
    const sheet = ensureSessionTab();
    const lastRow = sheet.getLastRow();

    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }

    // The response MUST carry a numeric version (unguarded tablet assignment). If the
    // bump itself fails, fall back to wall-clock: the count-drift self-heal (meta count
    // now stale vs 0 actual rows) bumps past it on the next read, so the gate recovers.
    let version = tryBumpSessionVersion_(sheet.getParent(), 0);
    if (typeof version !== 'number') version = new Date().getTime();

    return {
      success: true,
      version: version,
      message: 'Session cleared'
    };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Get list of dogs with parent emails from Lookup tab
 * Returns: { success: true, dogs: [{name, email, parentName}, ...] }
 */
function getDogList() {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.LOOKUP_TAB);
    const data = sheet.getDataRange().getValues();
    
    // Skip header row
    const dogs = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0] && row[0].toString().trim()) {
        dogs.push({
          name: row[0].toString().trim(),
          email: row[1] ? row[1].toString().trim() : '',
          parentName: row[2] ? row[2].toString().trim() : ''
        });
      }
    }
    
    // DIAGNOSTIC LOG: Track Lookup tab health — if this returns 0 or very few dogs,
    // the frontend's name matching will fail for all subsequent addDog() calls
    if (dogs.length === 0) {
      console.warn('[getDogList] WARNING: Lookup tab returned 0 dogs! Check tab name "' + CONFIG.LOOKUP_TAB + '" and column A data.');
    } else if (dogs.length < 10) {
      console.warn('[getDogList] WARNING: Lookup tab returned only ' + dogs.length + ' dogs — expected many more.');
    }
    
    return { success: true, dogs: dogs, count: dogs.length };

  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

// ============================================
// ADD DOGS FOR TODAY (Whiteboard integration)
// ============================================

/**
 * Build the list of dogs to auto-add for a meal period, sourced from the Whiteboard
 * Display. The frontend's "Add Dogs for Today" button calls this, then drops the
 * returned dogs into pens.
 *
 *   Morning Meal / Evening Meal → boarding + boarding-school dogs from the check-in/out
 *     feed, date-filtered (breakfast = slept here last night incl. dogs leaving this
 *     morning; dinner = here tonight incl. today's check-ins). penGroup = null (any pen).
 *   Lunch → today's full-day / half-day dogs from the whiteboard roster, kept only if
 *     listed in the B/T pen tab with B (→bottom) or T (→top). penGroup = 'top'|'bottom'.
 *
 * Returns { success, mealPeriod, today, dogs:[{name, penGroup}], skipped:[name], counts }.
 * Never throws to the client.
 */
function getTodayPlan(mealPeriod, forceFresh) {
  try {
    if (!mealPeriod) return { success: false, error: 'Missing mealPeriod' };
    if (mealPeriod !== 'Morning Meal' && mealPeriod !== 'Evening Meal' && mealPeriod !== 'Lunch') {
      return { success: false, error: 'Unknown mealPeriod: ' + mealPeriod };
    }

    // "Today" is authoritative in the business timezone, independent of the tablet clock.
    const today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');

    // Cache keys carry BOTH the date and the meal period, so a last-known-good plan can
    // never be served for the wrong meal or leak across midnight into the next day.
    const base = 'todayPlan|v1|' + today + '|' + mealPeriod;
    const freshKey = base + '|fresh';
    const lkgKey = base + '|lkg';

    // 1. A fresh plan short-circuits the flaky upstream entirely — the main win.
    //    `?fresh=1` bypasses it: the escape hatch for staff who just ticked "Lunch Y?" or
    //    changed the whiteboard and need to see it NOW rather than within the TTL. The
    //    last-known-good copy is still consulted below if the live read then fails.
    if (!forceFresh) {
      const cached = planCacheGet_(freshKey);
      if (cached) { cached.cached = true; return cached; }   // `cached` is diagnostic: it makes
      // cache effectiveness measurable from outside instead of inferred from response times.
    }

    // 2. Build it for real.
    const built = (mealPeriod === 'Lunch')
      ? getLunchPlan_(today)
      : getBoardingPlan_(mealPeriod, today);

    if (built && built.success && built.upstreamOk) {
      delete built.upstreamOk;                       // internal signal, not part of the wire contract
      planCachePut_(freshKey, built, CONFIG.PLAN_CACHE_FRESH_SEC);
      planCachePut_(lkgKey, { plan: built, capturedAt: new Date().toISOString() },
                    CONFIG.PLAN_CACHE_LKG_SEC);
      return built;
    }

    // 3. Upstream is down. A usable-but-stale board beats no board at all — but say so,
    //    loudly and with its age, so staff can judge it. Only ever from TODAY (key above).
    //    An EMPTY last-known-good is worse than none: the tablet would show the stale warning
    //    and then "No dogs found for today" — the exact lie this change exists to kill, just
    //    wearing a warning label. Fall through to the honest error instead. (We still WRITE
    //    empty plans to LKG above, so a quiet morning can't leave a stale non-empty board behind.)
    const lkg = planCacheGet_(lkgKey);
    if (lkg && lkg.plan && Array.isArray(lkg.plan.dogs) && lkg.plan.dogs.length > 0) {
      const stale = lkg.plan;
      stale.stale = true;
      stale.capturedAt = lkg.capturedAt;
      stale.upstreamError = (built && built.error) || 'upstream unavailable';
      return stale;
    }

    // 4. Nothing cached either — fail loud. Staff must never be told this is an empty day.
    return {
      success: false,
      mealPeriod: mealPeriod,
      today: today,
      error: (built && built.error) || 'Could not load today\'s plan.'
    };
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Script-cache helpers for the today-plan. Both are best-effort by design: CacheService
 * is an optimisation, never a dependency, so a cache outage (or a value over the 100KB
 * per-entry cap) must degrade to a live read rather than fail the request.
 */
function planCacheGet_(key) {
  try {
    const raw = CacheService.getScriptCache().get(key);
    if (!raw) return null;
    return safeJsonParse(raw, null);
  } catch (e) {
    console.warn('[planCacheGet_] ' + e.toString());
    return null;
  }
}

function planCachePut_(key, value, ttlSeconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), ttlSeconds);
  } catch (e) {
    console.warn('[planCachePut_] ' + e.toString());   // oversized value / cache unavailable
  }
}

/**
 * Breakfast / Dinner roster from the check-in/out feed.
 *   checkIn  = arrival day; checkOut = departure-morning day (last night = checkOut - 1).
 *   Breakfast (Morning Meal): checkIn <  today AND checkOut >= today
 *     → slept here last night; INCLUDES dogs leaving this morning, EXCLUDES today's arrivals.
 *   Dinner    (Evening Meal): checkIn <= today AND checkOut >  today
 *     → here tonight; INCLUDES today's check-ins, EXCLUDES today's check-outs.
 * Dates are ISO 'YYYY-MM-DD' so lexicographic string comparison is correct.
 * type ∈ {boarding, school} — both count.
 */
function getBoardingPlan_(mealPeriod, today) {
  const url = CONFIG.CHECKINOUT_URL +
    '?mode=checkinout&token=' + encodeURIComponent(CONFIG.CHECKINOUT_TOKEN);
  const probe = {};
  const feed = fetchJson_(url, {
    attempts: CONFIG.PLAN_FETCH_ATTEMPTS,
    deadlineMs: CONFIG.PLAN_FETCH_DEADLINE_MS,
    out: probe
  });
  // A dead feed (or a rejected CHECKINOUT_TOKEN, which answers 200 with success:false)
  // must NOT read as "no dogs boarding tonight" — say so and let getTodayPlan fall back.
  if (!probe.ok || !feed || (feed.success === false) || !Array.isArray(feed.stays)) {
    return {
      success: false,
      upstreamOk: false,
      mealPeriod: mealPeriod,
      today: today,
      error: 'Check-in/out feed unavailable: ' + (probe.error || 'unexpected response shape')
    };
  }
  const stays = feed.stays;

  const isMorning = (mealPeriod === 'Morning Meal');
  const seen = {};
  const dogs = [];

  for (let i = 0; i < stays.length; i++) {
    const stay = stays[i] || {};
    const name = stay.dogName ? stay.dogName.toString().trim() : '';
    const checkIn = stay.checkIn ? stay.checkIn.toString() : '';
    const checkOut = stay.checkOut ? stay.checkOut.toString() : '';
    if (!name || !checkIn || !checkOut) continue;

    const include = isMorning
      ? (checkIn < today && checkOut >= today)
      : (checkIn <= today && checkOut > today);
    if (!include) continue;

    const key = normName_(name);
    if (seen[key]) continue;   // a dog can have multiple stays; count once
    seen[key] = true;
    dogs.push({ name: name, penGroup: null });
  }

  dogs.sort(function (a, b) { return a.name.localeCompare(b.name); });

  return {
    success: true,
    mealPeriod: mealPeriod,
    today: today,
    upstreamOk: true,
    dogs: dogs,
    skipped: [],
    counts: { source: stays.length, eligible: dogs.length }
  };
}

/**
 * Lunch roster from the whiteboard. A dog present today (day-care OR boarding) is added to a
 * lunch pen ONLY when the master "Jot form Dog Details" sheet flags it "Lunch Y?" = Y AND
 * gives it a B (bottom) / T (top) pen:
 *   • "Lunch Y?" is the staff opt-in for the LUNCH PEN-FILL window — it controls who appears
 *     on the board at lunch, NOT whether a report is sent (that happens later on submit).
 *   • No Y → not added, for day-care and boarding alike (since 2026-06-19; before that
 *     day-care was pen-only and "Lunch Y?" gated boarding guests alone).
 *   • Y but no T/B pen → can't be placed → returned in `skipped` as a data gap.
 * The name join is exact (`normName_`) with a first+last-token fallback (ambiguity-guarded,
 * count === 1) that also bridges roster names carrying the owner surname the master dog-name
 * cell omits (roster "Oliver / Ollie Reed" ↔ master "Oliver", owner surname "Reed") — see
 * `readPenMap_`.
 */
function getLunchPlan_(today) {
  const DAYCARE = { 'Full Day': true, 'Half Day AM': true, 'Half Day PM': true };
  const BOARDING = { 'Boarding': true, 'Boarding School': true };

  // PRIMARY: read the Staff Board sheet directly — no web-app hop, so none of its ~40% 404s.
  let roster = null;
  let rosterSource = 'sheet';
  let rosterError = '';
  const direct = readStaffBoardToday_();
  if (direct.ok) {
    roster = direct.dogs;
  } else {
    // FALLBACK: the web app. Slower and flaky, but it is the producer's own reader, so it
    // covers the cases the direct read deliberately refuses to guess at (unrecognised headers)
    // as well as a sharing change on the workbook.
    // attempts:1 deliberately — this endpoint's failures take 16–43s, so a retry could never
    // clear the deadline gate, and the producer documents it "degrades sharply under
    // concurrent load". Retrying into a load-driven failure would deepen the outage.
    rosterSource = 'webapp';
    rosterError = direct.error;
    const probe = {};
    const board = fetchJson_(CONFIG.WHITEBOARD_TODAY_URL + '?action=loadToday', {
      attempts: 1,
      out: probe
    });
    if (!probe.ok || !board || (board.success === false) || !Array.isArray(board.dogs)) {
      // Both paths are down → report it; never pass it off as an empty day.
      return {
        success: false,
        upstreamOk: false,
        mealPeriod: 'Lunch',
        today: today,
        error: 'Whiteboard roster unavailable — sheet: ' + (direct.error || 'unknown') +
               '; web app: ' + (probe.error || 'unexpected response shape')
      };
    }
    roster = board.dogs;
  }

  const penData = readPenMap_();          // { map:{normName:'top'|'bottom'}, lunchY:{normName:true}, firstLast:{...}, ok }
  // The pen sheet is the SECOND way this can silently empty the board, and the nastier one:
  // the roster read succeeded, so every count looks plausible while `lunchY` is empty and the
  // "Lunch Y?" gate below drops every dog. An unreadable sheet, a missing tab gid, or a
  // re-keyed header must surface as an outage, not as "nobody is booked for lunch".
  if (!penData.ok && roster.length > 0) {
    return {
      success: false,
      upstreamOk: false,
      mealPeriod: 'Lunch',
      today: today,
      error: 'Pen sheet unreadable (' + (penData.error || 'no usable rows') +
             ') — cannot tell which dogs are booked for lunch.'
    };
  }
  const penMap = penData.map;
  const lunchYMap = penData.lunchY;
  const firstLast = penData.firstLast;

  const seen = {};
  const dogs = [];
  const skipped = [];

  for (let i = 0; i < roster.length; i++) {
    const entry = roster[i] || {};
    const name = entry.name ? entry.name.toString().trim() : '';
    const serviceType = entry.serviceType ? entry.serviceType.toString().trim() : '';
    const isDaycare = !!DAYCARE[serviceType];
    const isBoarding = !!BOARDING[serviceType];
    if (!name || (!isDaycare && !isBoarding)) continue;

    const key = normName_(name);
    if (seen[key]) continue;
    seen[key] = true;

    let penGroup = penMap[key];          // 'top' | 'bottom' | undefined
    let wantsLunch = !!lunchYMap[key];   // master "Lunch Y?" = Y (exact-name hit)
    if (penGroup !== 'top' && penGroup !== 'bottom') {
      // Tolerant fallback: match on first + last name token, for a middle/maiden name or
      // nickname the roster carries but the pen sheet omits (e.g. roster "Branko Rubi
      // Steene" vs pen sheet "Branko Steene"). Used ONLY when first+last resolves to exactly
      // one pen-bearing master dog (firstLast.count === 1), so it can never mis-assign.
      const tk = key.split(' ');
      if (tk.length >= 2) {
        const fl = firstLast[tk[0] + '|' + tk[tk.length - 1]];
        if (fl && fl.count === 1 && (fl.side === 'top' || fl.side === 'bottom')) {
          penGroup = fl.side;
          wantsLunch = !!fl.lunchY;       // exact name missed → adopt the uniquely-matched row's lunch flag
        }
      }
    }
    const hasPen = (penGroup === 'top' || penGroup === 'bottom');

    // Lunch pen-fill eligibility (day-care AND boarding alike, since 2026-06-19): a dog is added
    // to a lunch pen ONLY when the master sheet's "Lunch Y?" = Y. This is the staff opt-in for the
    // lunch board — NOT the lunch report (that's sent later when staff submit). A pen letter
    // without the Y flag is NOT added; the Y flag without a T/B pen can't be placed → `skipped`.
    if (!wantsLunch) continue;             // not flagged Lunch Y → not added to a lunch pen
    if (hasPen) dogs.push({ name: name, penGroup: penGroup });
    else skipped.push(name);               // flagged Lunch Y but no T/B pen → surface the data gap
  }

  // Top group first, alphabetical within each group (frontend fills top-1.. / bottom-1..).
  dogs.sort(function (a, b) {
    if (a.penGroup !== b.penGroup) return a.penGroup === 'top' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    success: true,
    upstreamOk: true,
    mealPeriod: 'Lunch',
    today: today,
    dogs: dogs,
    skipped: skipped,
    // `rosterSource` is diagnostic: it makes a silent fall-back to the flaky web app visible
    // from outside, so "the sheet read stopped working" can't hide behind a working button.
    rosterSource: rosterSource,
    rosterFallbackReason: rosterError || undefined,
    counts: { roster: roster.length, eligible: dogs.length, skipped: skipped.length }
  };
}

/**
 * Read the lunch pen-assignment (Top/Bottom) from the master "Jot form Dog Details"
 * sheet (CONFIG.PEN_SHEET_ID, tab gid CONFIG.PEN_TAB_GID). Column A = Dog Name;
 * the pen column ("Feeding Pen Top (T) OR Bottom (B)") holds B / T / blank.
 *
 * Returns { map, lunchY, firstLast }:
 *   map        – { normalizedDogName: 'top' | 'bottom' } for rows with B/T (the exact join).
 *   lunchY     – { normalizedDogName: true } for rows flagged "Lunch Y?" = Y (the lunch opt-in).
 *   firstLast  – { "first|last": { side, lunchY, count } } over EVERY named row, powering
 *                getLunchPlan_'s tolerant fallback: a roster name with an extra middle/maiden
 *                name or nickname (e.g. "Branko Rubi Steene" vs the sheet's "Branko Steene")
 *                still resolves when its first+last tokens uniquely (count === 1) hit one
 *                master dog. Each row is also indexed under first-name | OWNER surname (the
 *                "Last Name (Excel)" column), because the roster frequently appends the owner
 *                surname to a dog whose master name cell omits it (roster "Oliver / Ollie Reed"
 *                ↔ master "Oliver", owner "Reed"). count > 1 ⇒ ambiguous ⇒ fallback declines.
 *
 * The pen column is resolved by HEADER text, not a fixed position: this master sheet is
 * shared and edited by other workflows (e.g. col J van assignments), so a column inserted
 * ahead of it must not silently re-key the read. If the header isn't found it falls back
 * to CONFIG.PEN_COL_FALLBACK_INDEX (column K) and warns loudly.
 */
function readPenMap_() {
  const map = {};         // normName -> 'top' | 'bottom'  (exact pen-side join key)
  const lunchY = {};      // normName -> true  (master "Lunch Y?" = Y → a BOARDING dog opts into a lunch report)
  const firstLast = {};   // "first|last" -> { side:'top'|'bottom'|null, lunchY:bool, count } over all named rows
  // `ok` distinguishes "read the sheet, these are the real answers" from "could not read it".
  // Without it an unreadable sheet returns empty maps, the "Lunch Y?" gate drops every dog,
  // and the client is told the day is simply empty (2026-08-04).
  const out = { map: map, lunchY: lunchY, firstLast: firstLast, ok: false, error: '' };
  try {
    const ss = SpreadsheetApp.openById(CONFIG.PEN_SHEET_ID);
    const sheets = ss.getSheets();
    let sheet = null;
    for (let i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === CONFIG.PEN_TAB_GID) { sheet = sheets[i]; break; }
    }
    if (!sheet) {
      out.error = 'no tab with gid ' + CONFIG.PEN_TAB_GID;
      console.warn('[readPenMap_] No tab gid ' + CONFIG.PEN_TAB_GID + ' in sheet ' + CONFIG.PEN_SHEET_ID);
      return out;
    }

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) {
      out.error = 'sheet has no data rows';
      console.warn('[readPenMap_] pen sheet has no data rows');
      return out;
    }

    // Resolve the pen + lunch columns by header (shared master sheet → column order not guaranteed).
    const header = data[0].map(function (h) { return (h || '').toString().toLowerCase().trim(); });
    let penCol = -1, lunchCol = -1, lastCol = -1;
    for (let c = 0; c < header.length; c++) {
      if (penCol === -1 && header[c].indexOf('feeding pen') !== -1) penCol = c;
      if (lunchCol === -1 && header[c].indexOf('lunch') !== -1) lunchCol = c;
      if (lastCol === -1 && header[c].indexOf('last name') !== -1) lastCol = c;
    }
    if (penCol === -1) {
      penCol = CONFIG.PEN_COL_FALLBACK_INDEX;   // column K
      console.warn('[readPenMap_] "Feeding Pen" header not found; using fallback col index ' + penCol);
    }
    if (lunchCol === -1) {
      lunchCol = CONFIG.LUNCH_COL_FALLBACK_INDEX;   // column L
      console.warn('[readPenMap_] "Lunch Y?" header not found; using fallback col index ' + lunchCol);
    }
    if (lastCol === -1) {
      lastCol = CONFIG.LASTNAME_COL_FALLBACK_INDEX;   // column H = "Last Name (Excel)"
      console.warn('[readPenMap_] "Last Name" header not found; using fallback col index ' + lastCol);
    }

    for (let i = 1; i < data.length; i++) {   // skip header; col A (index 0) = Dog Name
      const name = data[i][0] ? data[i][0].toString().trim() : '';
      if (!name) continue;
      const pen = data[i][penCol] ? data[i][penCol].toString().trim().toUpperCase() : '';
      const side = (pen === 'B') ? 'bottom' : (pen === 'T') ? 'top' : null;
      const lf = data[i][lunchCol] ? data[i][lunchCol].toString().trim().toUpperCase() : '';
      const wantsLunch = (lf === 'Y' || lf === 'YES');
      const nn = normName_(name);
      if (side) map[nn] = side;       // blank / other → not in exact map (skipped unless fallback hits)
      if (wantsLunch) lunchY[nn] = true;
      // First+last index over every named row → tolerant fallback with an ambiguity guard.
      // Index under BOTH the dog-name's own first|last tokens AND first-name | owner-surname
      // (the "Last Name (Excel)" column), because the roster often appends the owner surname
      // to a dog whose master name cell omits it (roster "Oliver / Ollie Reed" ↔ master
      // "Oliver", owner "Reed"). Each row counts ONCE per distinct key, so the count===1
      // ambiguity guard in getLunchPlan_ stays honest.
      const tk = nn.split(' ');
      const ownerNN = (lastCol >= 0 && data[i][lastCol]) ? normName_(data[i][lastCol]) : '';
      const ownerTk = ownerNN ? ownerNN.split(' ') : [];
      const ownerLast = ownerTk.length ? ownerTk[ownerTk.length - 1] : '';
      const flKeys = {};
      flKeys[tk[0] + '|' + tk[tk.length - 1]] = true;        // dog-name first|last
      if (ownerLast) flKeys[tk[0] + '|' + ownerLast] = true;  // dog first-name | owner surname
      Object.keys(flKeys).forEach(function (fl) {
        if (!firstLast[fl]) firstLast[fl] = { side: side, lunchY: wantsLunch, count: 1 };
        else { firstLast[fl].count++; if (side) firstLast[fl].side = side; if (wantsLunch) firstLast[fl].lunchY = true; }
      });
    }
    // NOTE: "zero rows flagged Lunch Y?" is deliberately NOT treated as a failure. It is a
    // legitimate state (a genuinely quiet lunch), it would black out the button for the whole
    // day with no override, and the tablet already reports this case far better — it names the
    // roster count and points at the "Lunch Y?" column. Only a sheet we could not READ is !ok.
    out.ok = true;
  } catch (e) {
    out.error = e.toString();
    console.warn('[readPenMap_] Failed to read pen sheet: ' + e.toString());
  }
  return out;
}

/**
 * Today's roster read STRAIGHT from the Whiteboard project's Staff Board sheet, bypassing its
 * `?action=loadToday` web app (which 404s for ~40% of requests under concurrent load).
 *
 * This is a deliberate, read-only reach into another project's workbook, so it mirrors that
 * project's own reader (`loadBoardData`) for the two fields we consume and nothing else:
 *   • resolve columns by HEADER NAME, not position (other workflows edit this sheet);
 *   • a row counts when EITHER `ID` or `Dog_Name` is non-empty;
 *   • missing cells coerce to '' rather than undefined.
 * It deliberately does NOT mirror `getOrCreateSheet` — creating the tab would make this app a
 * writer into someone else's workbook. A missing tab is reported, never repaired.
 *
 * If the headers can't be resolved we return !ok rather than guessing by position: the caller
 * then falls back to the web app, which runs the producer's OWN reader (including its own
 * positional fallback). That keeps exactly one implementation of that heuristic — theirs.
 *
 * Returns { ok, dogs:[{name, serviceType}], error }.
 */
function readStaffBoardToday_() {
  const out = { ok: false, dogs: [], error: '' };
  try {
    const ss = SpreadsheetApp.openById(CONFIG.STAFF_BOARD_SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.STAFF_BOARD_TODAY_TAB);
    if (!sheet) {
      out.error = 'no "' + CONFIG.STAFF_BOARD_TODAY_TAB + '" tab in the Staff Board sheet';
      return out;
    }

    const data = sheet.getDataRange().getValues();
    if (!data.length) { out.error = 'Today tab is completely empty'; return out; }

    const header = data[0].map(function (h) {
      return (h === null || h === undefined) ? '' : h.toString().trim().toLowerCase();
    });
    let idCol = -1, nameCol = -1, typeCol = -1;
    for (let c = 0; c < header.length; c++) {
      if (idCol === -1 && header[c] === 'id') idCol = c;
      if (nameCol === -1 && header[c] === 'dog_name') nameCol = c;
      if (typeCol === -1 && header[c] === 'appointment_type') typeCol = c;
    }
    if (nameCol === -1 || typeCol === -1) {
      out.error = 'Today tab headers not recognised (Dog_Name / Appointment_Type missing)';
      console.warn('[readStaffBoardToday_] ' + out.error + ' — falling back to the web app');
      return out;
    }

    const cell = function (row, i) {
      if (i < 0 || i >= row.length) return '';
      const v = row[i];
      return (v === null || v === undefined) ? '' : v.toString().trim();
    };

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const id = cell(row, idCol);
      const name = cell(row, nameCol);
      if (!id && !name) continue;                    // producer's own row filter
      out.dogs.push({ name: name, serviceType: cell(row, typeCol) });
    }
    out.ok = true;
  } catch (e) {
    // Most likely a sharing/authorisation change on the Staff Board workbook.
    out.error = e.toString();
    console.warn('[readStaffBoardToday_] ' + out.error + ' — falling back to the web app');
  }
  return out;
}

/**
 * GET a URL and parse JSON. GAS web apps 302-redirect to googleusercontent;
 * UrlFetchApp follows redirects by default. Returns null on any failure.
 *
 * ⚠️ `null` means FAILED, not "empty" — a caller that turns null into an empty list
 * reports an outage to staff as a normal quiet day. Pass `opts.out` and check
 * `out.ok` to tell the two apart (see getLunchPlan_ / getBoardingPlan_).
 *
 * Retry (2026-08-04): the upstream Whiteboard web app returns HTTP 404 + a Google
 * "Page not found" page for a large minority of requests — measured ~40% today, and
 * 8–43s to fail. Retrying is only worth it when the failure was CHEAP: once we are
 * past `deadlineMs` the upstream is clearly struggling and another attempt would
 * blow the tablet's fetch budget, so we stop and let the caller fall back to cache.
 *   opts.attempts   max attempts (default 1 — every pre-existing caller is unchanged)
 *   opts.deadlineMs stop retrying once this much time has elapsed (default 0 = never retry)
 *   opts.out        {ok, error, attempts} written back for the caller
 */
function fetchJson_(url, opts) {
  opts = opts || {};
  const out = opts.out || {};
  const attempts = opts.attempts || 1;
  const deadlineMs = opts.deadlineMs || 0;
  const started = Date.now();
  let lastError = 'unknown';

  for (let i = 1; i <= attempts; i++) {
    out.attempts = i;
    try {
      const response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        const parsed = safeJsonParse(response.getContentText(), null);
        if (parsed !== null) { out.ok = true; out.error = ''; return parsed; }
        lastError = 'HTTP ' + code + ' but body was not JSON';   // Google HTML interstitial
      } else {
        lastError = 'HTTP ' + code;
      }
    } catch (e) {
      lastError = e.toString();
    }
    if (i >= attempts) break;
    if (deadlineMs && (Date.now() - started) >= deadlineMs) {
      lastError += ' (slow failure — not retrying)';
      break;
    }
    Utilities.sleep(400 * i);
  }

  out.ok = false;
  out.error = lastError;
  console.warn('[fetchJson_] failed after ' + out.attempts + ' attempt(s) for ' + url + ': ' + lastError);
  return null;
}

/**
 * Normalize a dog name for joining across data sources (whiteboard / B-T tab / Lookup):
 * fold smart/curly apostrophes to ASCII, lowercase, trim, collapse internal whitespace.
 * "Echo O’Malley" and "Echo O'Malley" both → "echo o'malley"; "Frida  walsh " → "frida walsh".
 */
function normName_(s) {
  return s.toString()
    .replace(/[‘’ʼ′`]/g, "'")   // curly/smart apostrophes → ASCII '
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Submit feeding report
 * 1. Read session data
 * 2. Look up parent emails
 * 3. Write to Temp tab (7 columns - NO Parent Name)
 * 4. Generate JotForm URLs
 * 5. Send to Telegram
 * 6. Clear session
 */
function submitReport(data) {
  try {
    // POST-BODY-FIRST: Trust the tablet's local snapshot (data.dogs) when present.
    // The tablet may have edits that never reached the Session tab due to transient
    // GAS sync failures — its in-memory view is the authoritative truth at submit time.
    // Fall back to the Session tab only when no dogs are in the POST body.
    let dogsInPens;
    let mealType;

    if (data && Array.isArray(data.dogs) && data.dogs.length > 0) {
      dogsInPens = data.dogs.filter(d => d.penId && d.penId !== '');
      mealType = data.mealType || 'Lunch';
    } else {
      const sessionResult = getSessionState();
      if (!sessionResult.success) {
        return { success: false, error: 'Failed to get session: ' + sessionResult.error };
      }
      dogsInPens = sessionResult.dogs.filter(d => d.penId && d.penId !== '');
      // Fallback path only: getSessionState returns dogs in raw Session-row order, which ignores the
      // within-pen feeding order. Order by [pen, position] so the fallback matches what the tablet's
      // POST-body path already sends (the normal submit path uses data.dogs and is unaffected).
      const penRank = {};
      ['top-1','top-2','top-3','top-4','top-5','bottom-1','bottom-2','bottom-3','bottom-4','bottom-5']
        .forEach((p, i) => { penRank[p] = i; });
      dogsInPens.sort((a, b) => {
        const pa = penRank[a.penId] === undefined ? 99 : penRank[a.penId];
        const pb = penRank[b.penId] === undefined ? 99 : penRank[b.penId];
        return pa !== pb ? pa - pb : (a.position || 0) - (b.position || 0);
      });
      mealType = (data && data.mealType) || sessionResult.mealType;
    }

    const reportDate = (data && data.date) || {
      day: new Date().getDate(),
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    };

    if (dogsInPens.length === 0) {
      return { success: false, error: 'No dogs assigned to pens' };
    }
    
    // Get lookup data for email matching
    const lookupResult = getDogList();
    if (!lookupResult.success) {
      return { success: false, error: 'Failed to load dog list: ' + lookupResult.error };
    }
    
    const lookupMap = {};
    lookupResult.dogs.forEach(dog => {
      lookupMap[dog.name.toLowerCase()] = dog;
    });
    
    // Open Temp sheet (all Temp mutations happen later, under the script lock)
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const tempSheet = ss.getSheetByName(CONFIG.TEMP_TAB);

    // Prepare rows for Temp tab and JotForm URLs
    const rows = [];
    const jotformLinks = [];
    const missingEmails = [];
    
    // Feeding status mapping
    const FEEDING_STATUS_MAP = {
      'all': 'All',
      'three-quarter': '3/4',
      'half': '1/2',
      'quarter': '1/4',
      'none': 'None'
    };
    
    dogsInPens.forEach((dog, index) => {
      // Prefer the tablet's pre-resolved 'name' (e.g. the single fuzzy match) over the raw typed
      // inputName, so a dog with matchedName='' but possibleMatches=['Bella'] reports as 'Bella' and
      // its parent email resolves. The Session-tab fallback has no 'name' field, so it still resolves
      // via matchedName -> inputName.
      const finalName = dog.matchedName || dog.name || dog.inputName || '';
      if (!finalName) return; // skip malformed row rather than crash

      // Normalize possibly-malformed POST-body fields so a single bad row can't throw mid-loop
      // or silently mis-map an unknown status to 'All'.
      const supplementTypes = Array.isArray(dog.supplementTypes) ? dog.supplementTypes : [];
      const foodConsumed = FEEDING_STATUS_MAP.hasOwnProperty(dog.status) ? FEEDING_STATUS_MAP[dog.status] : 'All';
      if (dog.status && !FEEDING_STATUS_MAP.hasOwnProperty(dog.status)) {
        console.warn('[submitReport] Unknown feeding status "' + dog.status + '" for ' + finalName + ' — defaulting to All');
      }

      const lookupData = lookupMap[finalName.toLowerCase()];
      const parentEmail = lookupData ? lookupData.email : '';
      
      if (!parentEmail) {
        missingEmails.push(finalName);
      }
      
      // Build supplement types string
      const supplementTypesStr = supplementTypes.join(', ');
      
      // Build comments (prescription medicine name)
      const comments = dog.prescriptionComment ? 'Prescription: ' + dog.prescriptionComment : '';
      
      // Row for Temp tab - 7 columns (NO Parent Name)
      // Dog Name | Parent Email | Meal | Food Consumed | Medicine Supplement | Supplement Types | Comments
      rows.push([
        finalName,
        parentEmail,
        mealType,
        foodConsumed,
        (dog.prescription || dog.supplements) ? 'Yes' : 'No',
        supplementTypesStr,
        comments
      ]);
      
      // Build dog data for JotForm URL
      const dogForJotform = {
        name: finalName,
        foodConsumed: foodConsumed,
        hasMedicineOrSupplement: (dog.prescription || dog.supplements) ? 'Yes' : 'No',
        medicineSupplements: [],
        prescriptionMedicine: dog.prescriptionComment || ''
      };
      
      // Build medicine/supplements array
      if (dog.prescription) {
        dogForJotform.medicineSupplements.push('Prescription Medicine');
      }
      if (supplementTypes.length > 0) {
        supplementTypes.forEach(st => {
          // Map supplement IDs to JotForm values
          const suppMap = {
            'calming': 'Calming Tablets',
            'hemp': 'Hemp Oil',
            'vitamins': 'Multi Vitamins',
            'probiotics': 'FortiFlora Probiotics'
          };
          if (suppMap[st]) {
            dogForJotform.medicineSupplements.push(suppMap[st]);
          }
        });
      }
      
      // Generate JotForm pre-filled URL
      const jotformUrl = buildJotformUrl(dogForJotform, parentEmail, mealType, reportDate);
      jotformLinks.push({
        name: finalName,
        pen: dog.penId,
        foodConsumed: foodConsumed,
        hasMedicine: dog.prescription || dog.supplements,
        url: jotformUrl
      });
    });
    
    // Rebuild the Temp tab atomically under the script lock: header self-heal (n8n's
    // whole-sheet clear can wipe row 1; without it n8n mis-reads every row), clear old
    // data, write the new rows. The slow Telegram UrlFetchApp call stays OUTSIDE the
    // lock so a hung send can't starve other tablets' writes into lock timeouts.
    const tempWrite = withScriptLock_('submitTempWrite', function () {
      ensureTempHeader_(tempSheet);
      const lastRow = tempSheet.getLastRow();
      if (lastRow > 1) {
        tempSheet.getRange(2, 1, lastRow - 1, CONFIG.TEMP_COLUMNS).clear();
      }
      if (rows.length > 0) {
        tempSheet.getRange(2, 1, rows.length, CONFIG.TEMP_COLUMNS).setValues(rows);
      }
      return { success: true };
    });
    if (!tempWrite.success) {
      // Nothing was sent and the session is untouched — the tablet can simply retry.
      return { success: false, telegramSent: false, error: 'Temp write failed: ' + tempWrite.error };
    }

    // Send to Telegram
    const telegramResult = sendTelegramSummary(mealType, reportDate, jotformLinks, missingEmails);

    // If Telegram delivery failed, the report has no review links to act on. Do NOT clear the
    // session — keep Temp + Session intact so the tablet can retry without losing any data.
    if (!telegramResult.success) {
      return {
        success: false,
        telegramSent: false,
        dogsProcessed: dogsInPens.length,
        missingEmails: missingEmails,
        error: 'Telegram delivery failed: ' + (telegramResult.error || JSON.stringify(telegramResult.response || {}))
      };
    }

    // Clear session only after a confirmed Telegram delivery. Short lock waits (the
    // tablet's fetch aborts at 12s and Temp write + Telegram already spent some of it)
    // with one retry; on a double failure report sessionCleared:false (additive field —
    // clients ignore it) and log loud. The dogs then legitimately remain in Session.
    let clearResult = withScriptLock_('submitClear', function () { return clearSessionCore_(); }, 3000);
    if (!clearResult.success) {
      clearResult = withScriptLock_('submitClearRetry', function () { return clearSessionCore_(); }, 3000);
    }
    if (!clearResult.success) {
      console.warn('[submitReport] session clear failed after Telegram delivery — dogs remain in Session: ' + clearResult.error);
    }

    return {
      success: true,
      telegramSent: true,
      sessionCleared: clearResult.success === true,
      dogsProcessed: dogsInPens.length,
      missingEmails: missingEmails,
      message: `${dogsInPens.length} dogs submitted. Check Telegram for review links.`
    };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Mobile-friendly URL encoding for JotForm
 */
function mobileEncode(str) {
  if (!str) return '';
  return encodeURIComponent(str)
    .replace(/%20/g, '+')
    .replace(/%40/g, '@')
    .replace(/%3A/g, ':')
    .replace(/%2F/g, '/');
}

/**
 * Build pre-filled JotForm URL (mobile-friendly)
 */
function buildJotformUrl(dog, parentEmail, mealType, reportDate) {
  const baseUrl = 'https://form.jotform.com/' + CONFIG.JOTFORM_ID;
  const params = [];
  
  params.push(CONFIG.JOTFORM_FIELDS.DATE_DAY + '=' + reportDate.day);
  params.push(CONFIG.JOTFORM_FIELDS.DATE_MONTH + '=' + reportDate.month);
  params.push(CONFIG.JOTFORM_FIELDS.DATE_YEAR + '=' + reportDate.year);
  params.push(CONFIG.JOTFORM_FIELDS.DOG_NAME + '=' + mobileEncode(dog.name));
  
  if (parentEmail) {
    params.push(CONFIG.JOTFORM_FIELDS.PARENT_EMAIL + '=' + mobileEncode(parentEmail));
  }
  
  params.push(CONFIG.JOTFORM_FIELDS.MEAL_TIME + '=' + mobileEncode(mealType));
  params.push(CONFIG.JOTFORM_FIELDS.FOOD_CONSUMED + '=' + mobileEncode(dog.foodConsumed));
  params.push(CONFIG.JOTFORM_FIELDS.HAS_MEDICINE_SUPPLEMENT + '=' + mobileEncode(dog.hasMedicineOrSupplement));
  
  if (dog.medicineSupplements && dog.medicineSupplements.length > 0) {
    const supplementsValue = dog.medicineSupplements.map(med => mobileEncode(med)).join(',');
    params.push(CONFIG.JOTFORM_FIELDS.MEDICINE_SUPPLEMENTS + '[]=' + supplementsValue);
  }
  
  if (dog.prescriptionMedicine) {
    params.push(CONFIG.JOTFORM_FIELDS.ADDITIONAL_COMMENTS + '=' + mobileEncode('Prescription: ' + dog.prescriptionMedicine));
  }
  
  return baseUrl + '?' + params.join('&');
}

/**
 * Neutralise Telegram legacy-Markdown control characters in free-text (dog names,
 * comments). Legacy 'Markdown' has no escape syntax, so an unbalanced _ * [ ] or `
 * makes the WHOLE sendMessage call fail with HTTP 400 and the report never sends.
 * Replacing them with spaces keeps the message readable and guarantees it parses.
 */
function escapeTelegramMarkdown(text) {
  return String(text == null ? '' : text)
    .replace(/[\\_*\[\]`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Send summary to Telegram with JotForm links
 */
function sendTelegramSummary(mealType, reportDate, jotformLinks, missingEmails) {
  try {
    const dateStr = reportDate.day + '/' + reportDate.month + '/' + reportDate.year;
    
    let message = '🍽️ *FEEDING REPORT READY FOR REVIEW*\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    message += '📅 *Date:* ' + dateStr + '\n';
    message += '🕐 *Meal:* ' + mealType + '\n';
    message += '🐕 *Dogs:* ' + jotformLinks.length + '\n\n';
    
    // Group by pen
    const byPen = {};
    jotformLinks.forEach(link => {
      const penKey = link.pen || 'Unassigned';
      if (!byPen[penKey]) byPen[penKey] = [];
      byPen[penKey].push(link);
    });
    
    // Build message by pen
    const penOrder = ['top-1', 'top-2', 'top-3', 'top-4', 'top-5', 'bottom-1', 'bottom-2', 'bottom-3', 'bottom-4', 'bottom-5'];
    
    penOrder.forEach(penId => {
      if (byPen[penId] && byPen[penId].length > 0) {
        const penLabel = penId.replace('-', ' ').replace(/\b\w/g, function(l){ return l.toUpperCase(); });
        message += '📍 *' + penLabel + '*\n';
        
        byPen[penId].forEach(dog => {
          let extras = '';
          if (dog.hasMedicine) extras = ' 💊';
          
          message += '   • ' + escapeTelegramMarkdown(dog.name) + ' — ' + dog.foodConsumed + extras + '\n';
          message += '     [Review Form](' + dog.url + ')\n';
        });
        message += '\n';
      }
    });
    
    // Warning for missing emails
    if (missingEmails.length > 0) {
      message += '⚠️ *Missing parent emails:*\n';
      missingEmails.forEach(name => {
        message += '   • ' + escapeTelegramMarkdown(name) + '\n';
      });
      message += '\n';
    }
    
    message += '━━━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '✅ Reply `/send` to submit all reports to JotForm\n';
    message += '❌ Reply `/cancel` to clear without submitting';
    
    // Send to Telegram — token read lazily HERE (one Properties read per submit),
    // never at global scope (see the _secret_ note at the top of the file).
    const botToken = _secret_('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      Logger.log('[sendTelegramSummary] TELEGRAM_BOT_TOKEN missing — set it in Script Properties');
      return { success: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
    }
    const telegramUrl = 'https://api.telegram.org/bot' + botToken + '/sendMessage';

    const payload = {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    };
    
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(telegramUrl, options);
    const result = JSON.parse(response.getContentText());
    
    return { success: result.ok, response: result };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Get data from Temp tab (for n8n to read)
 */
function getTempData() {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.TEMP_TAB);
    const data = sheet.getDataRange().getValues();
    
    if (data.length <= 1) {
      return { success: true, rows: [], count: 0 };
    }
    
    const rows = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0] && row[0].toString().trim()) {
        // 7 columns: Dog Name | Parent Email | Meal | Food Consumed | Medicine Supplement | Supplement Types | Comments
        rows.push({
          dogName: row[0],
          parentEmail: row[1],
          meal: row[2],
          foodConsumed: row[3],
          hasMedicineSupplement: row[4],
          supplementTypes: row[5],
          comments: row[6]
        });
      }
    }
    
    return { success: true, rows: rows, count: rows.length };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Guarantee the Temp tab's header lives in row 1, self-healing if it was wiped.
 *
 * n8n's "Read Temp Tab" node keys every row by row 1, so if row 1 is blank (e.g. n8n's
 * whole-sheet `clear` deleted it) the read promotes the first DOG row to column headers and
 * `Has Data?` ($json['Dog Name']) is undefined for every row → all reports misroute to the
 * "no reports to submit" branch. submitReport() writes data at row 2 and never recreated the
 * header, so a single wiped header poisoned every later cycle. This makes the writer robust:
 *  - Fast path: row 1 already says "Dog Name" → return (cheap single-cell read).
 *  - Repair: rebuild the tab as [header row 1] + [every real dog row], dropping blank/leftover
 *    rows. Idempotent and rectangular-safe (each row padded to TEMP_COLUMNS).
 * Returns the number of data (dog) rows present after the call.
 */
function ensureTempHeader_(sheet) {
  if (String(sheet.getRange(1, 1).getValue()).trim() === CONFIG.TEMP_HEADER[0]) {
    return Math.max(0, sheet.getLastRow() - 1);
  }

  const values = sheet.getDataRange().getValues();
  const dogs = values
    .filter(r => String(r[0]).trim() && String(r[0]).trim() !== CONFIG.TEMP_HEADER[0])
    .map(r => {
      const row = r.slice(0, CONFIG.TEMP_COLUMNS);
      while (row.length < CONFIG.TEMP_COLUMNS) row.push('');
      return row;
    });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, CONFIG.TEMP_COLUMNS).setValues([CONFIG.TEMP_HEADER]);
  if (dogs.length > 0) {
    sheet.getRange(2, 1, dogs.length, CONFIG.TEMP_COLUMNS).setValues(dogs);
  }
  return dogs.length;
}

/**
 * One-off / safe recovery: normalize the live Temp tab so row 1 is the header and all staged
 * dog rows sit at row 2+. Exposed via doGet(?action=repairTemp). Idempotent — running it on an
 * already-healthy tab is a no-op fast path.
 */
function repairTemp() {
  return withScriptLock_('repairTemp', function () {
    try {
      const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      const sheet = ss.getSheetByName(CONFIG.TEMP_TAB);
      const dogRows = ensureTempHeader_(sheet);
      return { success: true, dogRows: dogRows, message: 'Temp header ensured; ' + dogRows + ' data row(s) present' };
    } catch (error) {
      return { success: false, error: error.toString() };
    }
  });
}

/**
 * Clear Temp tab (keep header row)
 */
function clearTempTab() {
  return withScriptLock_('clearTemp', function () {
    try {
      const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      const sheet = ss.getSheetByName(CONFIG.TEMP_TAB);

      ensureTempHeader_(sheet);  // guarantee row 1 header survives even if it had been wiped

      const lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        sheet.getRange(2, 1, lastRow - 1, CONFIG.TEMP_COLUMNS).clear();
      }

      return { success: true, message: 'Temp tab cleared' };

    } catch (error) {
      return { success: false, error: error.toString() };
    }
  });
}

// ============================================
// TEST FUNCTIONS (Run from Apps Script editor)
// ============================================

/**
 * Test: Get session state
 */
function testGetSession() {
  const result = getSessionState();
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * Test: Add a dog to session
 */
function testAddDog() {
  const result = addDogToSession({
    id: 'test-' + Date.now(),
    inputName: 'Test Dog',
    matchedName: 'Test Dog',
    possibleMatches: ['Test Dog'],
    status: 'all',
    prescription: false,
    prescriptionComment: '',
    supplements: false,
    supplementTypes: [],
    penId: 'top-1',
    mealType: 'Lunch'
  });
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * Test: Clear session
 */
function testClearSession() {
  const result = clearSession();
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * Test: Get dog list
 */
function testGetDogList() {
  const result = getDogList();
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * Test: Send Telegram message
 */
function testTelegram() {
  const botToken = _secret_('TELEGRAM_BOT_TOKEN');
  if (!botToken) { Logger.log('TELEGRAM_BOT_TOKEN not configured (set it in Script Properties)'); return; }
  const telegramUrl = 'https://api.telegram.org/bot' + botToken + '/sendMessage';
  
  const payload = {
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: '🧪 Test message from Feeding Report Manager v2.0',
    parse_mode: 'Markdown'
  };
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(telegramUrl, options);
  Logger.log(response.getContentText());
}
