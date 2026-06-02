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
 * SESSION TAB COLUMNS (12 columns):
 * Dog_ID | Input_Name | Matched_Name | Possible_Matches | Status | Prescription | 
 * Prescription_Comment | Supplements | Supplement_Types | Pen_ID | Last_Updated | Meal_Type
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

const CONFIG = {
  SHEET_ID: '1Ejjoo55BaoCPRaLdmFb9EdqtiAT9eNa52QRWjuVThyc',
  LOOKUP_TAB: 'Lookup',
  SESSION_TAB: 'Session',
  TEMP_TAB: 'Temp',
  
  TELEGRAM_BOT_TOKEN: '8436854999:AAGk4PDevCMCJu76tIuraI-MjW0tH94sjek',
  TELEGRAM_CHAT_ID: '-1003653235960',
  
  JOTFORM_ID: '240143730611039',
  
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
    MEAL_TYPE: 11
  },
  
  // Temp tab has 7 columns (no Parent Name)
  TEMP_COLUMNS: 7
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
      'Last_Updated', 'Meal_Type'
    ]);
    sheet.setFrozenRows(1);
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
        lastUpdated: row[CONFIG.SESSION_COLS.LAST_UPDATED]
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
      dog.mealType || 'Lunch'
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
 * Clear Temp tab (keep header row)
 */
function clearTempTab() {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.TEMP_TAB);
    
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
