[CmdletBinding()]
param(
  [switch]$Validate
)

# Headless verification harness for the Fairy Tails TV feeding board.
# Generates per-scenario copies of index.html with fetch stubbed, runs them in
# headless Chrome at 1920x1080, extracts assertion JSON from document.title,
# and captures screenshots.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$repo = Split-Path -Parent (Split-Path -Parent $scriptDir)
$outDir = Join-Path $env:TEMP 'ftboard-tests'

function Resolve-FtbChrome {
  if (-not [string]::IsNullOrWhiteSpace($env:FTBOARD_CHROME)) {
    return $env:FTBOARD_CHROME
  }

  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $candidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  }
  if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }
  return 'chrome.exe'
}

$chrome = Resolve-FtbChrome
$chromeFound = Test-Path -LiteralPath $chrome -PathType Leaf

if ($Validate) {
  [pscustomobject]@{
    repoRoot = $repo
    outDir = $outDir
    chrome = $chrome
    chromeFound = $chromeFound
  } | ConvertTo-Json -Compress
  if (-not $chromeFound) {
    [Console]::Error.WriteLine("Chrome was not found at: $chrome")
    exit 1
  }
  exit 0
}

if (-not $chromeFound) {
  throw "Chrome was not found at: $chrome"
}

$manifest = @(
  'fixture', 'two', 'photo', 'eighteen', 'twenty', 'lists',
  'select_back', 'ok_toggle', 'no_rotate', 'empty', 'arrivals_only',
  'fail_nocache', 'fail_cache', 'backend_stale', 'overlap', 'xss',
  'bad_payload', 'hang_cache', 'worst_case', 'midnight'
)

function Remove-FtbKnownPath {
  param([string]$Path)

  $root = [IO.Path]::GetFullPath($outDir).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath($Path)
  if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path outside the scratch directory: $target"
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

if (Test-Path -LiteralPath $outDir -PathType Container) {
  foreach ($scenarioName in $manifest) {
    Remove-FtbKnownPath (Join-Path $outDir "shot_$scenarioName.png")
    Remove-FtbKnownPath (Join-Path $outDir "dom_$scenarioName.html")
    Remove-FtbKnownPath (Join-Path $outDir "harness_$scenarioName.html")
    Remove-FtbKnownPath (Join-Path $outDir "profile_$scenarioName")
  }
}

$html = [IO.File]::ReadAllText((Join-Path $repo 'tv-plans\index.html'))
New-Item -ItemType Directory -Force (Join-Path $outDir 'assets\img') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'tv-plans\assets\img\logo.jpg') -Destination (Join-Path $outDir 'assets\img\logo.jpg') -Force

function Convert-FtbFixtureDate {
  param(
    [string]$Date,
    [int]$Days
  )

  $parsed = [DateTime]::ParseExact(
    $Date,
    'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None
  )
  return $parsed.AddDays($Days).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
}

$fixturePath = Join-Path $scriptDir 'fixtures\api_sample.synthetic.json'
$fixtureData = [IO.File]::ReadAllText($fixturePath) | ConvertFrom-Json
$fixtureStart = [DateTime]::ParseExact(
  $fixtureData.dateRange.start,
  'yyyy-MM-dd',
  [Globalization.CultureInfo]::InvariantCulture,
  [Globalization.DateTimeStyles]::None
)
$fixtureShift = [int](([DateTime]::Today - $fixtureStart.Date).TotalDays)
foreach ($dog in $fixtureData.dogs) {
  $dog.checkIn = Convert-FtbFixtureDate $dog.checkIn $fixtureShift
  $dog.checkOut = Convert-FtbFixtureDate $dog.checkOut $fixtureShift
}
$fixtureData.dateRange.start = Convert-FtbFixtureDate $fixtureData.dateRange.start $fixtureShift
$fixtureData.dateRange.end = Convert-FtbFixtureDate $fixtureData.dateRange.end $fixtureShift
$fixtureData.lastUpdated = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
$fixtureJson = $fixtureData | ConvertTo-Json -Depth 20 -Compress

$utf8 = New-Object System.Text.UTF8Encoding($false)

# ---------- shared JS fragments ----------

$preCommon = @'
<script>
window.__errors = [];
window.onerror = function(msg, src, line) { window.__errors.push(String(msg) + ' @' + line); };
function __d(off) {
  var t = new Date(); t.setDate(t.getDate() + off);
  return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
}
function __feed(opts) {
  opts = opts || {};
  return {
    mealsPerDay: opts.meals || 'Two meals per day',
    foodTypes: opts.types || ['Kibble'],
    kibbleSummary: opts.kibble === undefined ? '2 x Large cups daily' : opts.kibble,
    wetFood: opts.wet || '',
    tinFood: opts.tin || '',
    specialNotes: opts.notes || '',
    medication: opts.med ? 'Yes' : 'No',
    medicationDetails: opts.medDetails || '',
    supplements: opts.supps || []
  };
}
function __dog(name, surname, inOff, outOff, o) {
  o = o || {};
  return {
    dogName: name, ownerSurname: surname,
    checkIn: __d(inOff), checkOut: __d(outOff),
    type: o.type || 'boarding',
    matched: o.matched === undefined ? true : o.matched,
    matchType: o.matched === false ? 'none' : 'exact',
    ambiguousMatch: false,
    feeding: o.matched === false ? null : __feed(o)
  };
}
function __okFetch(data) {
  window.fetch = function() {
    return Promise.resolve({ ok: true, status: 200, json: function() { return Promise.resolve(data); } });
  };
}
function __failFetch() {
  window.fetch = function() { return Promise.reject(new Error('Failed to fetch')); };
}
function __payload(dogs, err, feedErr) {
  return { dogs: dogs, dogCount: dogs.length, dateRange: { start: __d(0), end: __d(6) },
           lastUpdated: new Date().toISOString(), error: err || null, feedingError: feedErr || null };
}
try { window.localStorage.clear(); } catch (e) {}
</script>
'@

$inspector = @'
<script>
function __q(s) { return document.querySelector(s); }
function __qa(s) { return document.querySelectorAll(s); }
function __px(s) { var e = __q(s); return e ? parseFloat(getComputedStyle(e).fontSize) : null; }
function __vis(s) { var e = __q(s); return !!e && getComputedStyle(e).display !== 'none'; }
function __txt(s) { var e = __q(s); return e ? e.textContent : null; }
function __alphaOk(sel) {
  var els = __qa(sel); var last = null;
  for (var i = 0; i < els.length; i++) {
    if (!els[i].offsetParent) continue;
    var t = (els[i].textContent || '').toLowerCase();
    if (last !== null && t < last) return false;
    last = t;
  }
  return true;
}
function __inspect() {
  var logo = __q('.logo');
  var res = {
    errors: window.__errors,
    screen: (typeof state !== 'undefined' && state) ? state.screen : null,
    selPill: (function() { var t = __q('#todayPillBtn'); if (!t) return null; return t.className.indexOf('unselected') === -1 ? 'today' : 'tomorrow'; })(),
    focusedPill: (function() { var a = document.activeElement; return a && a.id ? a.id : null; })(),
    todayCount: __txt('#todayCount'), tomorrowCount: __txt('#tomorrowCount'),
    tcards: __qa('.tcard').length,
    prepItems: __qa('#prepList .list-item').length,
    tomItems: __qa('#tomorrowList .list-item').length,
    namePx: __px('.tcard-name'), qtyPx: __px('.qty-value'),
    notesPx: __px('.notes-text'), medPx: __px('.med-chip .med-text'),
    listPx: __px('.list-item'),
    alphaCards: __alphaOk('.tcard .name-first'),
    alphaPrep: __alphaOk('#prepList .list-name'),
    alphaTom: __alphaOk('#tomorrowList .list-name'),
    todayInd: __txt('#todayPageIndicator'),
    loading: __vis('#loadingState'), empty: __vis('#emptyState'), offline: __vis('#offlineState'),
    board: __vis('#todayZone') || __vis('#listsZone'),
    statusText: __txt('#statusText'),
    stale: __q('#statusPill').className.indexOf('stale') !== -1,
    errBanner: __vis('#errorBanner') ? __txt('#errorBanner') : '',
    warnBanner: __vis('#feedingWarning') ? __txt('#feedingWarning') : '',
    medChips: __qa('.med-chip').length, allergyChips: __qa('.allergy-chip').length,
    suppBlocks: __qa('.supp-block').length,
    suppText: __txt('.supp-text'),
    medFlags: __qa('.list-flag.med').length,
    listDetails: __qa('#tomorrowList .list-detail').length,
    suppDetails: __qa('#tomorrowList .supp-detail').length,
    clipWarns: (__vis('#prepClipWarn') ? 1 : 0) + (__vis('#tomorrowClipWarn') ? 1 : 0),
    noMatch: __qa('.no-match-banner').length,
    gridClass: __q('#todayGrid').className,
    tzs: (function() { var cs = __qa('.tcard'); var a = []; for (var i = 0; i < cs.length; i++) { var v = parseFloat(cs[i].style.getPropertyValue('--tz')); a.push(isNaN(v) ? null : Math.round(v * 100) / 100); } return a; })(),
    overflows: (function() { var b = __qa('.tcard-body'); var n = 0; for (var i = 0; i < b.length; i++) { if (b[i].scrollHeight > b[i].clientHeight + 2) n++; } return n; })(),
    listOverflow: (function() { var ls = __qa('.name-list'); var n = 0; for (var i = 0; i < ls.length; i++) { var e = ls[i]; if (!e.offsetParent) continue; if (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2) n++; } return n; })(),
    trunc: (function() {
      // Tolerance 4px: line-box/ellipsis rounding routinely sits at 1-2px even on
      // fully-shown text, while a real clip loses a whole line/word (at least 25px).
      var sels = ['.qty-value', '.med-chip .med-text', '.notes-text', '.supp-text', '.name-first', '.name-surname', '.list-name', '.list-surname'];
      var items = [];
      for (var s = 0; s < sels.length; s++) {
        var els = __qa(sels[s]);
        for (var i = 0; i < els.length; i++) {
          var e = els[i];
          if (!e.offsetParent) continue;
          if (e.scrollHeight > e.clientHeight + 4 || e.scrollWidth > e.clientWidth + 4) {
            items.push(sels[s].replace(/[ .#>-]/g, '') + '=' + (e.textContent || '').replace(/\s+/g, ' ').slice(0, 18));
          }
        }
      }
      return { count: items.length, items: items.slice(0, 10) };
    })(),
    cacheHasDogs: (function() { try { var c = JSON.parse(window.localStorage.getItem('ftFeedingBoardLastGood')); return !!(c && c.dogs && c.dogs.length > 0); } catch (e) { return false; } })(),
    clock: __txt('#clock'), countdown: __txt('#countdown'),
    logoOk: !!(logo && logo.complete && logo.naturalWidth > 0),
    xssText: (function() { var n = __q('.tcard-name'); return n ? n.textContent.slice(0, 30) : null; })()
  };
  document.title = JSON.stringify(res);
}
setTimeout(__inspect, INSPECT_DELAY);
</script>
'@

# ---------- scenario definitions ----------

$scenarios = @(
  @{ name = 'fixture'; budget = 16000; delay = 10000; shot = $true; pre = @'
<script>
// Return the date-rebased synthetic fixture through the successful fetch stub.
var __fixtureData = FIXTURE_JSON;
__okFetch(__fixtureData);
</script>
'@ },
  @{ name = 'two'; budget = 8500; delay = 5500; shot = $true; pre = @'
<script>
// Two dogs are in house and one is arriving, with mixed feeding details.
__okFetch(__payload([
  __dog('Bella', 'Smith', -2, 2, { med: true, medDetails: 'Apoquel 16mg with breakfast', notes: 'Slow feeder bowl please', wet: '1 sachet am', supps: ['Probiotic Powder/Tab'] }),
  __dog('Maximus Aurelius', 'Featherstonehaugh', 0, 3, { notes: 'Allergic to chicken - strictly no poultry treats', types: ['Kibble', 'Wet Food - Tin'], tin: 'Half tin pm', type: 'school', supps: ['Hemp Oil', 'Calming Tabs'] }),
  __dog('Pip', 'Jones', 1, 4, { meals: 'One meal per day' })
]));
</script>
'@ },
  @{ name = 'photo'; budget = 8500; delay = 5500; shot = $true; pre = @'
<script>
// Dense-board stress: 7 staying today, 0 arriving tomorrow, with long
// medication, food and notes strings of real-world lengths. All content is
// fabricated and was sanitised by the operator on 2026-08-19.
__okFetch(__payload([
  __dog('Axo', 'Zorblatt', -1, 3, { type: 'school', med: true,
    medDetails: 'Skin balm on ears and tail two times a day 1 AM 1 PM; 20KG dose of fabuprofen x 1/day',
    supps: ['Hemp Oil', 'Multivitamin Tabs', 'Probiotic Powder/Tab', 'Calming Tabs'],
    wet: 'Wet food Sachet - Whole', meals: 'Three meals per day', types: ['Wet Food - Sachet/Tray'], kibble: '' }),
  __dog('Bolt', 'Nebulon', -1, 2, { type: 'school', med: false,
    supps: ['Hemp Oil', 'Multivitamin Tabs', 'Calming Tabs'],
    kibble: 'Full Cup - Large Cup', meals: 'Two meals per day', types: ['Kibble'] }),
  __dog('Glimmer', 'Quixling', -1, 2, { kibble: 'Two Handfuls', wet: 'Wet food Sachet - Whole', meals: 'Two meals per day', types: ['Kibble', 'Wet Food - Sachet/Tray'] }),
  __dog('Luna', 'Vexworth', -1, 2, { meals: 'Two meals per day', kibble: '', types: ['Pre-Portioned by parents'] }),
  __dog('Momo', 'Snorkelby', -1, 2, { meals: 'Three meals per day', kibble: '', types: ['Pre-Portioned by parents'] }),
  __dog('Misty', 'Fablewick', -1, 2, { wet: 'Wet food Sachet - Whole', meals: 'Two meals per day', types: ['Wet Food - Sachet/Tray'], kibble: '',
    notes: 'She has 2 pouches AM and 1 PM, only eats when hand fed and likes it warmed a bit' }),
  __dog('Tock', 'pretendle', -1, 2, { kibble: 'Full Scoop (parent\'s scoop)', meals: 'One meal per day', types: ['Pre-Portioned by parents'],
    notes: 'Only has dinner has a drizzle of krill oil on her kibble. Parent Scoop is her bowl left in her bag' })
]));
</script>
'@ },
  @{ name = 'eighteen'; budget = 16000; delay = 10000; shot = $true; pre = @'
<script>
// 18 in house plus 6 arriving must render as one alphabetical g18 page,
// with no paging indicator or truncated content.
var dogs = [];
var names = ['Alfie','Bonnie','Charlie','Daisy','Eddie','Florence','Gus','Hattie','Ivy','Jasper','Kiki','Loki','Mabel','Nellie','Otis','Peggy','Quinn','Rex'];
for (var i = 0; i < 18; i++) {
  dogs.push(__dog(names[i], 'Owner' + i, -1, 2, { med: i < 2, medDetails: i < 2 ? 'Insulin 4 units with food, twice daily' : '', notes: i === 2 ? 'Allergic to grain' : 'Likes food mixed with warm water', wet: i % 3 === 0 ? '1 sachet each meal' : '' }));
}
var toms = ['Sage','Teddy','Una','Vera','Wally','Xena'];
for (var j = 0; j < 6; j++) {
  dogs.push(__dog(toms[j], 'TomOwner' + j, 1, 4, { med: j === 0, medDetails: j === 0 ? 'Metacam 1.5ml am' : '' }));
}
__okFetch(__payload(dogs));
</script>
'@ },
  @{ name = 'twenty'; budget = 16000; delay = 10000; shot = $true; pre = @'
<script>
// The design ceiling is 20 shuffled, mixed-heavy in-house dogs plus 4 arriving.
// They must render as one alphabetical g20 page with no truncation.
var dogs = [];
var names = ['Ziggy','Alfie','Milo','Bella','Rex','Coco','Nala','Daisy','Otis','Ivy','Hattie','Gus','Peggy','Jasper','Kiki','Loki','Quinn','Mabel','Teddy','Sage'];
for (var i = 0; i < 20; i++) {
  var o = { notes: i % 4 === 0 ? 'Allergic to chicken - no poultry treats. Food mixed with warm water' : '' };
  if (i % 3 === 0) { o.med = true; o.medDetails = 'Insulin 4 units with food twice daily plus joint supplement crushed into breakfast'; }
  if (i % 5 === 0) { o.wet = '1 sachet each meal'; o.types = ['Kibble', 'Wet Food - Sachet/Tray']; }
  if (i === 7) { o.matched = false; }
  if (i === 11) { o.kibble = ''; o.types = ['Pre-Portioned by parents']; }
  dogs.push(__dog(names[i], 'Owner' + i, -1, 2, o));
}
var toms = ['Wally','Una','Xena','Vera'];
for (var j = 0; j < 4; j++) {
  dogs.push(__dog(toms[j], 'TomOwner' + j, 1, 4, { med: j === 0, medDetails: j === 0 ? 'Metacam 1.5ml am' : '' }));
}
__okFetch(__payload(dogs));
</script>
'@ },
  @{ name = 'lists'; budget = 10000; delay = 7000; shot = $true; pre = @'
<script>
// Clicking the lists pill must show the alphabetical prep checklist and
// tomorrow arrivals, including medicine flags, details and checkbox bullets.
var dogs = [];
var names = ['Ziggy','Alfie','Milo','Bella','Rex','Coco','Nala','Daisy','Otis','Ivy','Hattie','Gus','Peggy','Jasper','Kiki','Loki','Quinn','Mabel','Teddy','Sage'];
for (var i = 0; i < 20; i++) {
  var o = {};
  if (i % 3 === 0) { o.med = true; o.medDetails = 'Insulin 4 units with food twice daily'; }
  if (i % 4 === 0) { o.notes = 'Allergic to chicken'; }
  if (i === 7) { o.matched = false; }
  dogs.push(__dog(names[i], 'Owner' + i, -1, 2, o));
}
var toms = ['Wally','Una','Xena','Vera'];
for (var j = 0; j < 4; j++) {
  dogs.push(__dog(toms[j], 'TomOwner' + j, 1, 4, { med: j === 0, medDetails: j === 0 ? 'Metacam 1.5ml am' : '' }));
}
__okFetch(__payload(dogs));
</script>
'@; post = @'
<script>
setTimeout(function() { document.getElementById('tomorrowPillBtn').click(); }, 5000);
</script>
'@ },
  @{ name = 'select_back'; budget = 10000; delay = 8000; shot = $false; pre = @'
<script>
// ArrowRight selects lists, then ArrowLeft returns to cards after the lists
// page has rendered and populated its prep items.
__okFetch(__payload([
  __dog('Bella', 'Smith', -2, 2, { med: true, medDetails: 'Apoquel 16mg with breakfast' }),
  __dog('Milo', 'Reed', -1, 3, {}),
  __dog('Ziggy', 'Cole', -1, 2, { notes: 'Allergic to grain' }),
  __dog('Alfie', 'Dunn', -1, 4, {}),
  __dog('Coco', 'Nash', -1, 2, {}),
  __dog('Pip', 'Jones', 1, 4, {}),
  __dog('Rex', 'Ward', 1, 3, { med: true, medDetails: 'Metacam 1.5ml am' })
]));
</script>
'@; post = @'
<script>
setTimeout(function() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); }, 5000);
setTimeout(function() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); }, 6500);
</script>
'@ },
  @{ name = 'ok_toggle'; budget = 10000; delay = 7000; shot = $false; pre = @'
<script>
// Enter must toggle to lists, while rapid repeat and synthesised click events
// are ignored so spatial-navigation remotes do not toggle straight back.
__okFetch(__payload([
  __dog('Bella', 'Smith', -2, 2, { med: true, medDetails: 'Apoquel 16mg with breakfast', supps: ['Hemp Oil'] }),
  __dog('Milo', 'Reed', -1, 3, {}),
  __dog('Pip', 'Jones', 1, 4, {})
]));
</script>
'@; post = @'
<script>
setTimeout(function() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, 5000);
setTimeout(function() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, 5120);
setTimeout(function() { document.getElementById('todayPillBtn').click(); }, 5240);
</script>
'@ },
  @{ name = 'no_rotate'; budget = 75000; delay = 70000; shot = $false; pre = @'
<script>
// With no input for 70 virtual seconds, the board must remain on TODAY cards;
// the old build rotated away after 45 seconds.
__okFetch(__payload([
  __dog('Bella', 'Smith', -2, 2, { med: true, medDetails: 'Apoquel 16mg with breakfast' }),
  __dog('Milo', 'Reed', -1, 3, {}),
  __dog('Ziggy', 'Cole', -1, 2, {}),
  __dog('Pip', 'Jones', 1, 4, {})
]));
</script>
'@ },
  @{ name = 'empty'; budget = 8500; delay = 5500; shot = $true; pre = @'
<script>
// No dog is in house today or arriving tomorrow, so show the empty state.
__okFetch(__payload([
  __dog('Future', 'Dog', 3, 6, {}),
  __dog('Gone', 'Dog', -5, -1, {}),
  __dog('LeavingToday', 'Dog', -3, 0, {})
]));
</script>
'@ },
  @{ name = 'arrivals_only'; budget = 8500; delay = 5500; shot = $true; pre = @'
<script>
// With no dogs today and three arriving, pin the lists screen immediately,
// show arrival medicine details and show the empty prep-panel message.
__okFetch(__payload([
  __dog('Rex', 'Ward', 1, 4, { med: true, medDetails: 'Apoquel 16mg with breakfast ONLY' }),
  __dog('Bella', 'Nash', 1, 3, { supps: ['Hemp Oil', 'Calming Tabs'] }),
  __dog('Coco', 'Hale', 1, 5, { notes: 'Allergic to chicken' })
]));
</script>
'@ },
  @{ name = 'fail_nocache'; budget = 8500; delay = 5500; shot = $false; pre = @'
<script>
// A failed fetch with no cached data exercises the offline error state.
__failFetch();
</script>
'@ },
  @{ name = 'fail_cache'; budget = 8500; delay = 5500; shot = $true; pre = @'
<script>
// A failed fetch with a six-hour-old cache must show the stale cached board.
(function() {
  var cached = __payload([
    __dog('Bella', 'Smith', -2, 2, { med: true, medDetails: 'Apoquel 16mg with breakfast' }),
    __dog('Pip', 'Jones', 1, 4, {})
  ]);
  cached.lastUpdated = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  try { window.localStorage.setItem('ftFeedingBoardLastGood', JSON.stringify(cached)); } catch (e) {}
})();
__failFetch();
</script>
'@ },
  @{ name = 'backend_stale'; budget = 8500; delay = 5500; shot = $false; pre = @'
<script>
// A successful payload carrying upstream warnings exercises backend staleness.
__okFetch(__payload([
  __dog('Bella', 'Smith', -2, 2, {})
], 'Showing last known data - upstream error: Bandwidth quota exceeded', 'Could not fetch feeding data from JotForm: timeout'));
</script>
'@ },
  @{ name = 'overlap'; budget = 8500; delay = 5500; shot = $false; pre = @'
<script>
// Two records for the same dog meet at tomorrow's stay boundary.
__okFetch(__payload([
  __dog('Rolo', 'Barnwell', -2, 1, { med: true, medDetails: 'Eye drops twice daily' }),
  __dog('Rolo', 'Barnwell', 1, 4, {})
]));
</script>
'@ },
  @{ name = 'xss'; budget = 8500; delay = 5500; shot = $false; pre = @'
<script>
// Markup-like dog and feeding values must remain text and must not execute.
__okFetch(__payload([
  __dog('<img src=x onerror="window.__errors.push(0)">', '<b>Bad</b>', -1, 2, { notes: '<script>window.__errors.push(1)<\/script> allergic', types: ['<i>Weird Food</i>'], kibble: '<u>2 cups</u>' })
]));
</script>
'@ },
  @{ name = 'bad_payload'; budget = 8500; delay = 5500; shot = $false; pre = @'
<script>
// An error-shaped response with valid cached data exercises cache fallback.
(function() {
  var cached = __payload([
    __dog('Bella', 'Smith', -2, 2, { med: true, medDetails: 'Apoquel 16mg with breakfast' }),
    __dog('Pip', 'Jones', -1, 3, {})
  ]);
  try { window.localStorage.setItem('ftFeedingBoardLastGood', JSON.stringify(cached)); } catch (e) {}
})();
__okFetch({ error: 'Forbidden: invalid or missing token' });
</script>
'@ },
  @{ name = 'hang_cache'; budget = 115000; delay = 100000; shot = $false; pre = @'
<script>
// A fetch that never settles must time out and fall back to cached data.
(function() {
  var cached = __payload([
    __dog('Bella', 'Smith', -2, 2, { med: true, medDetails: 'Apoquel 16mg with breakfast' })
  ]);
  try { window.localStorage.setItem('ftFeedingBoardLastGood', JSON.stringify(cached)); } catch (e) {}
})();
window.fetch = function() { return new Promise(function() {}); };
</script>
'@ },
  @{ name = 'worst_case'; budget = 8000; delay = 4000; shot = $true; pre = @'
<script>
// Ten heavy cards with long medicine, allergy and food details must fit on
// one g10 page, shrinking per card until all content shows without truncation.
var dogs = [];
var names = ['Alfie','Bonnie','Charlie','Daisy','Eddie','Florence','Gus','Hattie','Ivy','Jasper'];
for (var i = 0; i < 10; i++) {
  dogs.push(__dog(names[i], 'Owner' + i, -1, 2, {
    med: true,
    medDetails: 'Insulin 4 units with food twice daily, plus joint supplement crushed into breakfast',
    supps: ['Hemp Oil', 'Multivitamin Tabs', 'Probiotic Powder/Tab', 'Calming Tabs'],
    notes: 'Allergic to chicken and beef - absolutely no poultry treats. Likes food mixed with warm water and a long walk afterwards',
    types: ['Kibble', 'Wet Food - Sachet/Tray', 'Wet Food - Tin'],
    kibble: '2 x Large cups daily', wet: '1 sachet each meal', tin: 'Half tin pm'
  }));
}
__okFetch(__payload(dogs, 'Showing last known data - upstream error: Acuity throttled'));
</script>
'@ },
  @{ name = 'midnight'; budget = 22000; delay = 16000; shot = $false; pre = @'
<script>
// Crossing midnight must refresh today and tomorrow membership by date.
__okFetch(__payload([
  __dog('TodayOnly', 'Dog', -2, 1, {}),
  __dog('ArrivesTomorrow', 'Dog', 1, 3, {}),
  __dog('DayAfter', 'Dog', 2, 5, {})
]));
</script>
'@; post = @'
<script>
var __realBase = Date.now();
var __simStart = (function() { var t = new Date(); t.setHours(23, 59, 55, 0); return t.getTime(); })();
nowDate = function() { return new Date(__simStart + (Date.now() - __realBase)); };
</script>
'@ }
)

$results = @{}
$resultsMap = @{}
foreach ($scenario in $scenarios) {
  $name = $scenario.name
  $pre = $preCommon + $scenario.pre.Replace('FIXTURE_JSON', $fixtureJson)
  $post = ''
  if ($scenario.post) { $post = $scenario.post }
  $post += $inspector.Replace('INSPECT_DELAY', [string]$scenario.delay)

  $preMarker = '  <script>'
  $postMarker = '</body>'
  foreach ($marker in @($preMarker, $postMarker)) {
    $markerCount = ([regex]::Matches($html, [regex]::Escape($marker))).Count
    if ($markerCount -ne 1) {
      throw "Expected exactly one '$marker' marker in index.html; found $markerCount."
    }
  }
  $doc = $html.Replace($preMarker, "$pre`n$preMarker")
  $doc = $doc.Replace($postMarker, "$post`n$postMarker")
  $file = Join-Path $outDir "harness_$name.html"
  [IO.File]::WriteAllText($file, $doc, $utf8)

  $profile = Join-Path $outDir "profile_$name"
  $fileUrl = "file:///$($file.Replace('\','/'))"
  $dumpFile = Join-Path $outDir "dom_$name.html"
  # Retry the whole LAUNCH, not just the read.
  # The old loop retried [IO.File]::ReadAllText only. When Chrome wrote an EMPTY dump the
  # read SUCCEEDED, returned '' and broke on the first iteration, so Chrome was never re-run
  # and the scenario was recorded as a hard "NO TITLE FOUND" failure. Measured 25/08/2026:
  # ~18% of run.sh executions lost one arbitrary scenario this way, which left the gate
  # (which runs the suite six times) only ~30% likely to pass on correct code.
  # A retry gets a FRESH profile dir: a not-yet-exited Chrome from the previous scenario can
  # still hold a lock on the old one, and a locked profile is the likeliest way a launch
  # produces no output at all.
  $domText = ''
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -eq 1) { $attemptProfile = $profile } else { $attemptProfile = ($profile + '_r' + $attempt) }
    if (Test-Path $dumpFile) { Remove-Item $dumpFile -Force -ErrorAction SilentlyContinue }
    cmd /c "`"$chrome`" --headless=new --disable-gpu `"--user-data-dir=$attemptProfile`" --window-size=1920,1080 --virtual-time-budget=$($scenario.budget) --dump-dom `"$fileUrl`" > `"$dumpFile`" 2>nul"
    $domText = $null
    for ($try = 0; $try -lt 10; $try++) {
      try { $domText = [IO.File]::ReadAllText($dumpFile); break } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($null -eq $domText) { $domText = '' }
    if ($domText -match '<title>') { break }
    # Loud on purpose: a silent retry would hide a scenario that is genuinely broken.
    if ($attempt -lt $maxAttempts) {
      Write-Host ("  RETRY " + $name + ": headless Chrome produced no <title> (attempt " + $attempt + " of " + $maxAttempts + ")")
      Start-Sleep -Milliseconds 750
    } else {
      Write-Host ("  RETRY EXHAUSTED " + $name + ": still no <title> after " + $maxAttempts + " attempts")
    }
  }
  if ($domText -match '<title>(.*?)</title>') {
    $decoded = [System.Net.WebUtility]::HtmlDecode($Matches[1])
    $results[$name] = $decoded
    try {
      $resultsMap[$name] = $decoded | ConvertFrom-Json
    } catch {
      $resultsMap[$name] = $null
    }
  } else {
    $results[$name] = 'NO TITLE FOUND'
    $resultsMap[$name] = $null
  }

  if ($scenario.shot) {
    cmd /c "`"$chrome`" --headless=new --disable-gpu `"--user-data-dir=$profile`" --window-size=1920,1080 --virtual-time-budget=$($scenario.budget) `"--screenshot=$outDir\shot_$name.png`" `"$fileUrl`" 2>nul" | Out-Null
  }
}

foreach ($key in $results.Keys | Sort-Object) {
  Write-Output "=== $key ==="
  Write-Output $results[$key]
}

. (Join-Path $scriptDir 'assert_results.ps1')
$failureCount = Test-FtbResults $resultsMap
$actualNames = @($resultsMap.Keys | Sort-Object)
$expectedNames = @($manifest | Sort-Object)
if (($actualNames.Count -ne $expectedNames.Count) -or
    (($actualNames -join "`n") -ne ($expectedNames -join "`n"))) {
  $failureCount++
}
exit [Math]::Min(200, $failureCount)
