// Acceptance test: Android vertical touch scroll on a populated board.
// Bug (10/08/2026): `body { overscroll-behavior: none }` stops Chromium chaining the
// vertical delta of a touch gesture that starts inside `.fb-pens` (a horizontal
// scroll container) up to the page scroller — so once dogs are in pens, the page
// cannot be scrolled up/down on an Android phone.
//
// Real CDP touch events against the repo's ACTUAL index.html in an emulated Android
// phone viewport. Mouse/JS-event tests cannot catch this class of bug (see the
// frontend-gotchas skill): only dispatched touch streams exercise Chromium's
// scroll-latching + chaining path.
//
// Standalone: `node tests/android-scroll.smoke.mjs` (not wired into tests/run.sh —
// needs the local Playwright chromium cache). Exit code = number of failures.
// SAFETY: every request that is not 127.0.0.1 is aborted — nothing reaches
// production GAS/n8n; the board is populated purely client-side.
'use strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// playwright-core: env override first, then the globally installed @playwright/mcp copy.
const PWC = process.env.PLAYWRIGHT_CORE_DIR
  || path.join(process.env.APPDATA || '', 'npm/node_modules/@playwright/mcp/node_modules/playwright-core');
const CHROME = process.env.SMOKE_CHROME
  || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1228/chrome-win64/chrome.exe');
if (!fs.existsSync(PWC)) { console.error('FATAL: playwright-core not found at ' + PWC + ' (set PLAYWRIGHT_CORE_DIR)'); process.exit(90); }
if (!fs.existsSync(CHROME)) { console.error('FATAL: chromium not found at ' + CHROME + ' (set SMOKE_CHROME)'); process.exit(91); }
const pw = createRequire(import.meta.url)(PWC);

let failures = 0;
function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await pw.chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 892 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
});
await ctx.route('**', route =>
  route.request().url().startsWith('http://127.0.0.1') ? route.continue() : route.abort());
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// Populate: 15 dogs across the three leftmost top pens so the page overflows vertically.
await page.evaluate(async () => {
  const names = ['Alfie','Bella','Coco','Daisy','Ella','Freddie','George','Holly','Ivy','Jack','Kiki','Luna','Milo','Nala','Ollie'];
  for (const n of names) { try { await addDog(n); } catch (e) {} }
  const penIds = ['top-1', 'top-2', 'top-3'];
  for (let i = 0; i < dogs.length; i++) { try { await moveDogToPen(dogs[i].id, penIds[i % penIds.length]); } catch (e) {} }
});
await page.waitForTimeout(500);

const overflows = await page.evaluate(() => document.scrollingElement.scrollHeight > window.innerHeight + 50);
if (!overflows) { console.error('FATAL: populated page does not overflow vertically — harness precondition broken'); process.exit(92); }

const cdp = await ctx.newCDPSession(page);
async function flick(x, y, dx, dy, steps = 10, stepMs = 12) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x + dx * i / steps), y: Math.round(y + dy * i / steps), id: 1 }] });
    await page.waitForTimeout(stepMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(600);
}
const scrollY = () => page.evaluate(() => document.scrollingElement.scrollTop);
const pensX = () => page.evaluate(() => document.querySelector('.fb-pens').scrollLeft);
// Reset BEFORE measuring points: client coordinates captured in a scrolled page go
// stale the moment the scroll is reset (this masked itself pre-fix, when nothing
// scrolled, and broke tests 3-4 post-fix).
const resetScroll = async () => {
  await page.evaluate(() => { document.scrollingElement.scrollTop = 0; document.querySelector('.fb-pens').scrollLeft = 0; });
  await page.waitForTimeout(150);
};
const points = () => page.evaluate(() => {
  const tiles = document.querySelectorAll('.pen-dog');
  let tile = null;
  for (const el of tiles) {
    const r = el.getBoundingClientRect();
    if (r.top > 80 && r.bottom < window.innerHeight - 250) { tile = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; break; }
  }
  const p = document.querySelector('.fb-pens').getBoundingClientRect();
  const p2 = document.querySelector('.pen[data-pen-id="top-2"]').getBoundingClientRect();
  return {
    tile,
    penBg: { x: Math.round(p.left + 4), y: Math.round(p.top + 60) },
    pen2Header: { x: Math.round(p2.left + p2.width / 2), y: Math.round(p2.top + 20) }
  };
});

// 1 — vertical flick starting ON A TILE must scroll the page
{
  await resetScroll();
  const pts = await points();
  const b = await scrollY();
  await flick(pts.tile.x, pts.tile.y, 0, -300);
  const a = await scrollY();
  report('vertical-flick-on-tile-scrolls-page', a > b, `scrollY ${b} -> ${a}`);
}

// 2 — vertical flick starting on the pens-row background must scroll the page
{
  await resetScroll();
  const pts = await points();
  const b = await scrollY();
  await flick(pts.penBg.x, pts.penBg.y, 0, -300);
  const a = await scrollY();
  report('vertical-flick-on-pen-background-scrolls-page', a > b, `scrollY ${b} -> ${a}`);
}

// 3 — long-press drag still moves a dog between pens; nothing wedges afterwards
{
  await resetScroll();
  const pts = await points();
  const before = await page.evaluate(() => (pens['top-2'] || []).length);
  const t2 = pts.pen2Header;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts.tile.x, y: pts.tile.y, id: 1 }] });
  await page.waitForTimeout(450);            // past LONG_PRESS_MS (300)
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(pts.tile.x + (t2.x - pts.tile.x) * i / 8), y: Math.round(pts.tile.y + (t2.y + 20 - pts.tile.y) * i / 8), id: 1 }] });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => (pens['top-2'] || []).length);
  const wedged = await page.evaluate(() => FRMDrag.isDragging() || document.body.classList.contains('is-dragging') || document.querySelectorAll('.drag-ghost').length > 0);
  report('long-press-drag-still-works-no-wedge', after > before && !wedged, `top-2 ${before} -> ${after}, wedged=${wedged}`);
}

// 4 — horizontal flick on pen chrome still scrolls the pen row
{
  await resetScroll();
  const pts = await points();
  const b = await pensX();
  await flick(pts.pen2Header.x, pts.pen2Header.y, -250, 0);
  const a = await pensX();
  report('horizontal-row-swipe-still-works', a > b, `pens scrollLeft ${b} -> ${a}`);
}

await browser.close();
server.close();
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures);
