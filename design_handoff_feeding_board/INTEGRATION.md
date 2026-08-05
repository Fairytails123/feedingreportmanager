# Integration brief — do not break production

This repo has a documented history of changes that **passed a green test suite and still broke
production**. Read `HANDOVER.md` and `CLAUDE.md` in the repo root before touching anything. This
file maps the redesign onto that reality.

---

## 0. The one-line summary

The redesign changes **markup, CSS and the drag engine** inside `index.html` (and `display/display.html`).
It must change **nothing** about the sync layer, the mutation queue, the submit gate, the endpoint
contract or the shared contract values.

## 1. Hard gate

```bash
bash tests/run.sh          # syntax + contract drift + backend + tablet + display. MUST be green.
LIVE=1 bash tests/run.sh   # + live assertions against the real n8n API
```

`tests/tablet.test.js` extracts the inline `<script>` from `index.html` and evaluates it with
`new Function`. **This means the redesign must keep `index.html` a single self-contained file with one
inline script, and must keep every function name those tests reference.** If you rename a function
the harness looks up, the suite fails for the wrong reason and you will be tempted to edit the test.
Don't — rename it back.

A green suite is necessary and **not sufficient**. After deploying, exercise the real path on a real
Android tablet and read the real response.

## 2. Do not touch — the sync layer

These are load-bearing and the redesign has no reason to go near them. Each bullet is a bug that
already shipped:

- **`SESSION_API_URL` is n8n on the VPS, not Apps Script.** The live board is *not* the Google Sheet;
  the Session tab is a mirror. Apps Script keeps only `submitReport`, `getTodayPlan`, `getDogList`.
- **The durable mutation queue** (`mutationQueue`, `feedingManager.queue.v1`, `enqueue`,
  `flushQueue`, `applyRemoteState`) and its op-collapse rules. The redesign's edits must go through
  the existing `syncAddDog` / `syncUpdateDog` / `syncDeleteDog` / `syncMealType` wrappers — do not
  POST from a UI handler.
- **`applyRemoteState` merges; it never wholesale-replaces `dogs`/`pens`.** It also sorts each pen by
  `position`. That sort is what stops the 5s poll clobbering a reorder.
- **One version-first poll**, running while editing *and* while offline. Do not re-add an entry gate
  on `isOnline` or `isSyncPaused()`.
- **`updateConnectionUI()` is the single owner of the banner and the Submit button state.** Submit is
  enabled only when `isOnline && mutationQueue.length === 0`. The new connection pill and offline
  banner must be driven **from inside that function** — do not add a second writer.
- **Timeout budgets**: `FETCH_TIMEOUT_MS` 12s, `SYNC_WRITE_TIMEOUT_MS` 45s,
  `PLAN_FETCH_TIMEOUT_MS` 45s + retry, `PROBE_ATTEMPTS` 2. Leave them alone. A self-inflicted abort
  is what staff experienced as "connection lost".
- **Mutation responses carry no `version`; `clearSession` does.**
- **`shared/contract.js`** — `PEN_ORDER`, `STATUS_VALUES`, the URLs, `FETCH_TIMEOUT_MS`. The redesign
  does not change any of them, so `node scripts/check_contract.js` must still pass. The status
  **values** stay `all | three-quarter | half | quarter | none`; only their on-screen glyphs change,
  and per-surface glyphs are explicitly not contract.

## 3. Functionality that must survive, and where it lives now

Verify each of these by hand after the port. All exist today; none may regress.

| Behaviour | Current implementation |
|---|---|
| Add a dog by typing, two-tier name match | `addDog`, `matchDogName`, `fuzzyMatchDogName` |
| Unmatched dog → pick-a-match card | `renderStagingArea` unmatched branch, `resolveMatch` |
| Hardcoded `JOTFORM_DOG_NAMES` fallback when Lookup returns < 10 dogs | `loadDogList` |
| Add today's dogs, incl. `?fresh=1` on a repeat press and the `stale` warning in the `confirm()` text | `addDogsForToday` |
| Spread dogs across least-occupied eligible pens | `pickLeastOccupiedPen` |
| Pen membership set **before** `syncAddDog` (that ordering is load-bearing) | `addDogsForToday` |
| Move between pens **and** reorder within a pen, at the drop position | `computeDropIndex`, `moveDogToPen`, `reindexPen` |
| Dense positions `(i+1)*1000`, syncing only changed dogs, no new queue op | `reindexPen` |
| Delete by dragging to the bin | `deleteDog` |
| Meal type change | `updateMealType`, `syncMealType` (calls `pauseSync()` first) |
| Portion / prescription / supplement edits | `updateDogStatus`, `togglePrescription`, `updatePrescriptionComment`, `toggleSupplements`, `toggleSupplementType` — each calls `pauseSync()` |
| Preview grouped by pen in canonical order | `showPreview` |
| Submit gated on `result.success && result.telegramSent` | `confirmSubmit` |
| Offline banner + Submit lock | `updateConnectionUI`, `showOfflineBanner` |
| Manual retry | `retryConnection` |
| Haptics | `triggerHaptic` |

**`pauseSync()` must be called from every new edit handler**, exactly as the current ones do. Miss it
and a poll will fight a live edit.

## 4. Suggested order of work

Each step ends with `bash tests/run.sh` green and a commit. Do not combine steps.

1. **Tokens and fonts.** Replace the `:root` block with `implementation/tokens.css`; swap the Nunito
   `<link>` for Caprasimo + Figtree. Everything will look wrong and still work — that is the point of
   doing it alone.
2. **Drag engine.** Replace the touch/mouse handler block (`handleTouchStart` … `handleMouseUp`,
   `checkTouchScroll`, `cancelTouchDrag`, `startDragTouch`, `startDragMouse`, `handleTouchMove`,
   `handleTouchEnd`, `handleMouseMove`, `handleMouseUp`, `updateDropTargetHighlight`,
   `createGhostElement`, `removeGhostElement`, plus the `pointerenter`/`pointerleave` handlers in
   `initPens`) with `implementation/drag-engine.js`. **Keep `computeDropIndex`, `moveDogToPen`,
   `deleteDog`, `showDropZones`, `hideDropZones`, `clearDropIndicator`, `showDropIndicator` and
   `triggerHaptic` as they are** — the engine calls them. Do this against the *current* markup, before
   any restyling, so you can prove the engine alone fixes Android.
   **Then test on a real Android tablet and a real Android phone before continuing.**
3. **Dog tile.** Rewrite the `renderPen` template: two-row collapsed tile, segmented portion control,
   expand-on-tap panel, badges. Wire the same handlers. Delete `.dog-card`/`.pen-dog` CSS as you go.
4. **Layout.** Container queries on the board root; rail, pen grid, phone tray. Remove the old
   `@media (max-width: 600px)` and `(min-width: 900px)` rules and the `.pen-row-scroll` machinery.
5. **Sheets.** Restyle the preview modal as a bottom sheet; add the Add-today's-dogs sheet. Note the
   existing code uses a blocking `confirm()` for the stale-roster warning **on purpose** — a toast may
   never paint. If you move that into the sheet, the sheet must be shown before the network call and
   must not depend on a toast.
6. **Connection states.** New pill + banner, driven from `updateConnectionUI` only.
7. **TV display.** `display/display.html` separately. It consumes `shared/contract.js` at publish
   time and defines none of those values itself — keep it that way. Publish only via
   `bash scripts/publish_display.sh "msg"`; never edit the retired OneDrive copy. The TV picks up a
   new version **only on a browser refresh on the TV itself**.

## 5. Traps specific to this redesign

- **`body.is-dragging { overflow: hidden }` must go.** It is what makes the page jump under the finger
  on Android. The new engine prevents scrolling by cancelling `touchmove`, and auto-scrolls at the
  edges instead. Deleting that rule is part of the fix, not a side effect.
- **Do not put `touch-action: none` on tiles.** Only the document-level non-passive `touchmove`
  cancels scrolling, and only while a drag is actually active. Tiles keep `touch-action: pan-y` so the
  board still scrolls when a finger lands on one.
- **Do not take pointer capture on `pointerdown`.** It retargets `pointerup` and the browser then
  resolves the click against the captured element — every button inside a tile stops working. Capture
  is taken at the moment the long-press becomes a drag. (This bug was hit and fixed during design;
  don't reintroduce it.)
- **The offline banner is `position: fixed` on purpose** so it never reflows the drag layout. The
  redesign keeps it out of flow for the same reason — it shifts the board with padding, not by
  entering the flow.
- **Deleting a dog from a collapsed tile is gone by design.** Delete is the bin, or the button inside
  the expanded tile. Do not add a `×` back to the collapsed tile.
- **`scroll-snap-type` must be disabled during a drag** or programmatic scrolling gets snapped back.
- **`renderPen` rebuilds a pen's innerHTML.** With the new expand-on-tap tile, re-rendering while a
  tile is open must preserve which tile is open and any focus/caret in the medicine input. Either keep
  the expanded-tile id in a module variable and re-apply it after render, or update the changed tile in
  place. The current code calls `renderPen(getDogPen(dogId))` after every edit — that will now collapse
  the panel the user is typing in.
- **Sixteen dogs is normal; 34 happens.** Top pens hold up to 3, bottom pens up to 5 on a busy day.
  Check the layout at both.

## 6. Definition of done

- `bash tests/run.sh` green; `LIVE=1 bash tests/run.sh` green; `node scripts/check_contract.js` clean.
- On a real **Android tablet** (landscape) and a real **Android phone** (portrait): long-press a dog,
  carry it across the screen — the board pans — drop it into a different pen at a chosen position, and
  confirm the change appears on a second device and on the TV.
- Kill wifi mid-edit: banner appears, Submit locks, edits persist across a reload, and reconnecting
  drains the queue and re-enables Submit.
- A full round: add today's dogs, set portions, add a medicine note, preview, submit, and confirm the
  Telegram summary is grouped by pen in canonical order with the within-pen order you set.
