/**
 * Assemble the publishable TV display page: inject shared/contract.js into
 * display/display.html at the "// @@CONTRACT@@" marker, normalise to LF, and
 * write the self-contained page to the path given as argv[2].
 *
 *   node scripts/assemble_display.js <output-path>
 *
 * Called by scripts/publish_display.sh — can also be run standalone to inspect
 * the assembled artifact.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = process.argv[2];
if (!out) { console.error('usage: node scripts/assemble_display.js <output-path>'); process.exit(1); }

const source = fs.readFileSync(path.join(root, 'display', 'display.html'), 'utf8');
const contract = fs.readFileSync(path.join(root, 'shared', 'contract.js'), 'utf8');

const markerRe = /^[ \t]*\/\/ @@CONTRACT@@[ \t]*$/m;
if (!markerRe.test(source)) {
  console.error('ASSEMBLE FAIL: // @@CONTRACT@@ marker not found in display/display.html');
  process.exit(1);
}

let assembled = source.replace(markerRe, contract);
assembled = assembled.replace(/\r\n/g, '\n');  // repo + Pages artifact stay LF

// Note: prose mentions of the marker token in comments are fine — only an intact
// marker LINE (which the regex matches) means the injection failed.
if (markerRe.test(assembled)) {
  console.error('ASSEMBLE FAIL: marker line still present after injection');
  process.exit(1);
}
for (const needle of ['FRM_CONTRACT', 'frmMakeGasFetch', 'staleBanner', '?action=getSessionVersion']) {
  if (!assembled.includes(needle)) {
    console.error('ASSEMBLE FAIL: assembled page missing expected content: ' + needle);
    process.exit(1);
  }
}

fs.writeFileSync(out, assembled, 'utf8');
console.log('Assembled display page -> ' + out + ' (' + assembled.length + ' bytes, LF)');
