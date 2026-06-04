/**
 * Feeding Report Manager - Google Apps Script Backend
 * VERSION 2.0 - Real-Time Sync Edition
 * 
 * Sheet ID: 1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc
 * Tabs: Lookup (permanent), Session (real-time sync), Temp (submission staging)
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
var _SCRIPT_PROPS = PropertiesService.getScriptProperties();
function _secret_(key) {
  return _SCRIPT_PROPS.getProperty(key) || '';
}

const CONFIG = {
  SHEET_ID: '1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc',
  LOOKUP_TAB: 'Lookup',
  SESSION_TAB: 'Session',
  TEMP_TAB: 'Temp',
  
  TELEGRAM_BOT_TOKEN: _secret_('TELEGRAM_BOT_TOKEN'),   // from Script Properties (not inline)
  TELEGRAM_CHAT_ID: '-1003653235960',                   // group id — not a secret, left inline

  JOTFORM_ID: '240143730611039',

  // ── Whiteboard Display integration (for the "Add Dogs for Today" button) ──
  // These point at the separate Whiteboard project's GAS web apps. They are read
  // server-side via UrlFetchApp (no browser CORS). The URLs + token are already
  // public in the Pages-hosted whiteboard display, so this introduces no new secret.
  WHITEBOARD_TODAY_URL: 'https://script.google.com/macros/s/AKfycbzqXD9OCM5oSNFdy3OF7pOG0PRcpy4dgkEYWJBVh40CFHJgjvSpPn6SE-mNjloo-GKw/exec', // ?action=loadToday → today's daycare/boarding roster (lunch source)
  CHECKINOUT_URL: 'https://script.google.com/macros/s/AKfycbz2kc3lJbrGk7lw9jVcZMdUrPWjRx4qBARM8YVAIARhYAlQwCzlhHBbKswyOcVHytmB7Q/exec', // ?mode=checkinout&token=… → boarding stays w/ reliable dates (breakfast/dinner source)
  CHECKINOUT_TOKEN: 'ft-k9-board-2024-sec',
  BT_PEN_GID: 1567330092,   // tab in THIS feeding sheet: Dog Name | Pen Number (B/T/blank) | Size of Dog
  
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
        result = getTodayPlan(e.parameter.mealPeriod);
        break;
      case 'repairTemp':
        result = repairTemp();
        break;
      default:
        result = { success: true, status: 'ok', message: 'Feeding Report API v2.0 - Real-Time Sync' };
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
        result = getTodayPlan(data.mealPeriod);
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
    const data = sheet.getDataRange().getValues();
    
    if (data.length <= 1) {
      return { 
        success: true, 
        dogs: [], 
        mealType: 'Lunch',
        version: new Date().getTime(),
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
    
    return { 
      success: true, 
      dogs: dogs, 
      mealType: mealType,
      version: new Date().getTime(),
      count: dogs.length 
    };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Get just the version timestamp (for efficient polling)
 */
function getSessionVersion() {
  try {
    const sheet = ensureSessionTab();
    const lastRow = sheet.getLastRow();
    
    if (lastRow <= 1) {
      return { success: true, version: 0, count: 0 };
    }
    
    // Get the most recent Last_Updated value
    const lastUpdatedCol = CONFIG.SESSION_COLS.LAST_UPDATED + 1;
    const range = sheet.getRange(2, lastUpdatedCol, lastRow - 1, 1);
    const values = range.getValues();
    
    let maxVersion = 0;
    for (const row of values) {
      if (row[0] && row[0] > maxVersion) {
        maxVersion = row[0];
      }
    }
    
    return { success: true, version: maxVersion, count: lastRow - 1 };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Add a new dog to the session
 */
function addDogToSession(dog) {
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
    
    return { 
      success: true, 
      dogId: dog.id,
      version: timestamp,
      message: 'Dog added to session' 
    };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Update an existing dog in the session
 */
function updateDogInSession(dogId, updates) {
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
    
    return { 
      success: true, 
      dogId: dogId,
      version: timestamp,
      message: 'Dog updated' 
    };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Delete a dog from the session
 */
function deleteDogFromSession(dogId) {
  try {
    const sheet = ensureSessionTab();
    const data = sheet.getDataRange().getValues();
    
    // Find and delete the dog's row
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][CONFIG.SESSION_COLS.DOG_ID] == dogId) {
        sheet.deleteRow(i + 1);
        return { 
          success: true, 
          dogId: dogId,
          version: new Date().getTime(),
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
 */
function setSessionMealType(mealType) {
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
    
    return { 
      success: true, 
      mealType: mealType,
      version: timestamp,
      message: 'Meal type updated' 
    };
    
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Clear the entire session (only called after submission or explicit clear)
 */
function clearSession() {
  try {
    const sheet = ensureSessionTab();
    const lastRow = sheet.getLastRow();
    
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }
    
    return { 
      success: true, 
      version: new Date().getTime(),
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
function getTodayPlan(mealPeriod) {
  try {
    if (!mealPeriod) return { success: false, error: 'Missing mealPeriod' };

    // "Today" is authoritative in the business timezone, independent of the tablet clock.
    const today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');

    if (mealPeriod === 'Morning Meal' || mealPeriod === 'Evening Meal') {
      return getBoardingPlan_(mealPeriod, today);
    }
    if (mealPeriod === 'Lunch') {
      return getLunchPlan_(today);
    }
    return { success: false, error: 'Unknown mealPeriod: ' + mealPeriod };
  } catch (error) {
    return { success: false, error: error.toString() };
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
  const feed = fetchJson_(url);
  const stays = (feed && Array.isArray(feed.stays)) ? feed.stays : [];

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
    dogs: dogs,
    skipped: [],
    counts: { source: stays.length, eligible: dogs.length }
  };
}

/**
 * Lunch roster: today's full-day / half-day dogs from the whiteboard, kept only if
 * present in the B/T pen tab with B (bottom) or T (top). Boarding dogs do not get a
 * lunch report; dogs with a blank/absent pen are returned in `skipped` for visibility.
 */
function getLunchPlan_(today) {
  const DAYCARE = { 'Full Day': true, 'Half Day AM': true, 'Half Day PM': true };

  const board = fetchJson_(CONFIG.WHITEBOARD_TODAY_URL + '?action=loadToday');
  const roster = (board && Array.isArray(board.dogs)) ? board.dogs : [];
  const penMap = readPenMap_();   // { normName: 'top' | 'bottom' }

  const seen = {};
  const dogs = [];
  const skipped = [];

  for (let i = 0; i < roster.length; i++) {
    const entry = roster[i] || {};
    const name = entry.name ? entry.name.toString().trim() : '';
    const serviceType = entry.serviceType ? entry.serviceType.toString().trim() : '';
    if (!name || !DAYCARE[serviceType]) continue;

    const key = normName_(name);
    if (seen[key]) continue;
    seen[key] = true;

    const penGroup = penMap[key];   // 'top' | 'bottom' | undefined
    if (penGroup !== 'top' && penGroup !== 'bottom') {
      skipped.push(name);           // not in the B/T tab, or blank pen
      continue;
    }
    dogs.push({ name: name, penGroup: penGroup });
  }

  // Top group first, alphabetical within each group (frontend fills top-1.. / bottom-1..).
  dogs.sort(function (a, b) {
    if (a.penGroup !== b.penGroup) return a.penGroup === 'top' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    success: true,
    mealPeriod: 'Lunch',
    today: today,
    dogs: dogs,
    skipped: skipped,
    counts: { roster: roster.length, eligible: dogs.length, skipped: skipped.length }
  };
}

/**
 * Read the B/T pen-assignment tab (gid CONFIG.BT_PEN_GID) in THIS feeding sheet.
 * Columns: Dog Name | Pen Number (B/T/blank) | Size of Dog.
 * Returns { normalizedDogName: 'top' | 'bottom' } — only rows with B or T; blanks skipped.
 */
function readPenMap_() {
  const map = {};
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const sheets = ss.getSheets();
    let sheet = null;
    for (let i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === CONFIG.BT_PEN_GID) { sheet = sheets[i]; break; }
    }
    if (!sheet) {
      console.warn('[readPenMap_] No tab with gid ' + CONFIG.BT_PEN_GID + ' found.');
      return map;
    }

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {   // skip header
      const name = data[i][0] ? data[i][0].toString().trim() : '';
      const pen = data[i][1] ? data[i][1].toString().trim().toUpperCase() : '';
      if (!name) continue;
      if (pen === 'B') map[normName_(name)] = 'bottom';
      else if (pen === 'T') map[normName_(name)] = 'top';
      // blank / other → not mapped (skipped at lunch)
    }
  } catch (e) {
    console.warn('[readPenMap_] Failed to read pen tab: ' + e.toString());
  }
  return map;
}

/**
 * GET a URL and parse JSON. GAS web apps 302-redirect to googleusercontent;
 * UrlFetchApp follows redirects by default. Returns null on any failure so callers
 * default to an empty roster rather than throwing.
 */
function fetchJson_(url) {
  try {
    const response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      console.warn('[fetchJson_] HTTP ' + code + ' for ' + url);
      return null;
    }
    return safeJsonParse(response.getContentText(), null);
  } catch (e) {
    console.warn('[fetchJson_] fetch failed for ' + url + ': ' + e.toString());
    return null;
  }
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
    
    // Open Temp sheet
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const tempSheet = ss.getSheetByName(CONFIG.TEMP_TAB);

    // Self-heal the header first: n8n's whole-sheet clear can wipe row 1, and we write data at
    // row 2 below — without a header row n8n mis-reads every row. ensureTempHeader_ rebuilds it.
    ensureTempHeader_(tempSheet);

    // Clear existing data (keep header)
    const lastRow = tempSheet.getLastRow();
    if (lastRow > 1) {
      tempSheet.getRange(2, 1, lastRow - 1, CONFIG.TEMP_COLUMNS).clear();
    }
    
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
      // (the Temp tab was already cleared above) or silently mis-map an unknown status to 'All'.
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
    
    // Write to Temp tab
    if (rows.length > 0) {
      tempSheet.getRange(2, 1, rows.length, CONFIG.TEMP_COLUMNS).setValues(rows);
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

    // Clear session only after a confirmed Telegram delivery
    clearSession();

    return {
      success: true,
      telegramSent: true,
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
    
    // Send to Telegram
    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
      Logger.log('[sendTelegramSummary] TELEGRAM_BOT_TOKEN missing — set it in Script Properties');
      return { success: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
    }
    const telegramUrl = 'https://api.telegram.org/bot' + CONFIG.TELEGRAM_BOT_TOKEN + '/sendMessage';

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
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.TEMP_TAB);
    const dogRows = ensureTempHeader_(sheet);
    return { success: true, dogRows: dogRows, message: 'Temp header ensured; ' + dogRows + ' data row(s) present' };
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * Clear Temp tab (keep header row)
 */
function clearTempTab() {
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
  if (!CONFIG.TELEGRAM_BOT_TOKEN) { Logger.log('TELEGRAM_BOT_TOKEN not configured (set it in Script Properties)'); return; }
  const telegramUrl = 'https://api.telegram.org/bot' + CONFIG.TELEGRAM_BOT_TOKEN + '/sendMessage';
  
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
