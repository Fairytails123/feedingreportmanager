# AS-BUILT — where the shipped UI deliberately differs from this handoff

Implemented 2026-08-05 (@37). `README.md` and `designs/*.dc.html` in this folder are the **design
spec as delivered** and have deliberately been left untouched, so the original intent stays
readable. This file is the **shipped reality**. Where the two disagree, the shipped reality wins
and the reason is below.

> ⚠️ Every item here was a decision, not an oversight. If you are about to "fix" the
> implementation back towards the spec, read the reason first — three of these were made *after*
> measuring the result on a real device or on the live board.

---

## 1. The portion control is a `<select>`, not the 5-way segmented control — OWNER DECISION

**Spec:** README §2 "Dog tile", Row 2 — five buttons `All · ¾ · ½ · ¼ · None` in a
`repeat(4,1fr) 1.55fr` grid.

**Shipped:** a single colour-coded dropdown.

**Why:** the segmented control is one tap, but five side-by-side targets set a **wide floor on the
tile**, and the tile sets the pen width. Measured on a 412px phone in portrait: **one pen on
screen at a time**, so a dog could not be carried to the next pen without an off-screen drag. With
the dropdown a pen is ~154px and **2.3 pens are visible**; tablet portrait went from 3 pens across
to ~5. Nothing changed at ≥1060px, where all 10 pens already fit a 5-column grid.

The portion is still colour-coded on the closed control **and** on the tile's left edge, so the
board still reads at a glance — which is what the segmented control was really buying.

**Do not revert this without asking the owner.** It is their call, made in response to using the
first build.

## 2. Viewport `@media`, not container queries

**Spec:** README §"Screens / views" — "Layout switches are driven by **container queries on the
board root**, not viewport media queries, so the component is correct inside any wrapper."

**Shipped:** the same breakpoints (719 / 1059 / 1060 / 1400) as `@media`, with
`container-type: inline-size` still declared on the root.

**Why:** the board **is** the page here — there is no wrapper — so the two are pixel-identical,
and `@container` has a hard support floor (Chrome 105+). On a tablet browser below that floor an
unsupported `@container` block does not degrade, it **drops the entire layout**. The stated
benefit only applies to an embed that does not exist. The root still declares `container-type`, so
if the board is ever embedded, switching these blocks back is a find-and-replace.

## 3. `color-mix()` written as the equivalent `rgba()`

**Spec:** `implementation/tokens.css` — `--color-divider` and the three shadows use `color-mix()`.

**Shipped:** the exact numeric equivalents, e.g.
`color-mix(in srgb, #2e2b25 14%, transparent)` → `rgba(46, 43, 37, 0.14)`.

**Why:** identical pixels; `color-mix()` needs Chrome 111+ and this page has to render on whatever
browser the staff tablet is carrying. Same reasoning as item 2.

## 4. Pointer listeners live on `document`, not on the tile

**Spec:** `implementation/drag-engine.js` attaches `pointermove`/`pointerup`/`pointercancel` to the
tile in `onPointerDown`.

**Shipped:** they are attached to `document` for the duration of the gesture. Pointer capture is
still taken on the tile at lift, exactly as the handoff intends.

**Why:** an element-level listener dies if the node is replaced mid-gesture — and a background
poll re-rendering a pen is precisely when a drag must **not** be dropped. Capture still retargets
the events and they still bubble to `document`, so both properties hold at once. The
`frontend-gotchas` skill flags this exact failure mode from a previous project. Belt to the same
braces: `pollForUpdates` refuses to `applyRemoteState` while `isDragActive()`.

## 5. Things the design has no equivalent for, kept anyway

Removing working functionality is not a design decision to make on the owner's behalf:

- **"Clear board"** (`clearAll`) — a quiet ghost button in the rail, and a trash icon button in the
  phone tray. It was a full-weight button in the old action bar; the design has no equivalent.
- **The meal segmented control on a phone** — README §3 omits it from the bottom tray. Without it
  a phone cannot change the meal at all, so it is there, compact, at the top of the tray.
- **A `<select>` fallback for the unmatched-name picker** when a dog has more than 6 possible
  matches. The design shows match *buttons*; the fuzzy matcher can return up to 15.

## 6. Adjustments made after measuring, within the spirit of the design

- **TV: names wrap instead of ellipsising at the `xl`/`lg` scale tiers.** With one dog on the board
  the type is at its largest, and "Bella Mills" plus two badges rendered as `"Bell…"` — unreadable
  from the doorway, which is the entire point of that screen. Those tiers only apply when a pen
  holds ≤3 dogs, so there is vertical room to spare. The dense tiers still ellipsise.
- **TV sizes are `calc(n * var(--u))`** where `--u` is `1cqh` behind an `@supports`, falling back to
  `1vh`. Same reasoning as item 2, and the TV browser is even less ours to choose.
- **Badges moved from the name row to the portion row.** In a ~140px pen, two 22px badges plus the
  chevron left the name about 34px (`"De…"`). The name is the primary identifier.
- **`.portion-wrap` has `min-width: 88px` and its row wraps**, so with both badges present the
  badges take their own line rather than squeezing `"None"` into its own chevron.
- **`.fb-pen` / `.pen-dog` carry `min-width: 0`.** A flex item's automatic minimum size is its
  *min-content* size, so one wide descendant (the expanded panel's "Take off the board" button)
  silently overrode the pen's flex-basis and made every pen 195px instead of 154px.
- **Error toasts last 8s, not 2.2s.** They carry sentences staff must act on — skipped dogs by
  name, a submit failure reason. Confirmations still use the design's short cadence.

## 7. Spec items honoured exactly, listed so nobody "improves" them away

- The stale-roster warning stays in the **blocking `confirm()`**, not the Today sheet. A sheet can
  be missed; `tests/tablet.test.js` **S9** pins this. The Today sheet is progress + result only.
- The offline banner is `position: fixed` and shifts the board with padding — it never enters the
  flow, so it cannot reflow the drag layout.
- Deleting from a *collapsed* tile is gone. Delete is the bin, or the button inside the expanded
  tile.
- No `body.is-dragging { overflow: hidden }`, and no `touch-action: none` on a tile at rest.
- The "not yet reviewed" state was explicitly rejected by the client and has not been added.

## 8. `overscroll-behavior` is split by axis, not the spec's `none` — MEASURED ON-DEVICE CLASS BUG

**Spec:** `designs/Feeding Board.dc.html` sets `overscroll-behavior: none` on the page (no
pull-to-refresh eating a drag), and the first build shipped it.

**Shipped (2026-08-10):** `overscroll-behavior-x: none; overscroll-behavior-y: auto;`

**Why:** with `none` (or `contain`) on the viewport, Android Chrome refuses to chain the
**vertical** part of a touch gesture that starts inside `.fb-pens` — a horizontal scroll
container — up to the page scroller. Once dogs are in pens, tiles cover most of the screen, so a
populated board **could not be scrolled up or down at all** on a phone (Kam's report, verified
with real CDP touch events and a property bisect; `tests/android-scroll.smoke.mjs` pins it).
Pull-to-refresh still cannot interrupt a drag — the engine preventDefaults `touchmove` while
dragging. **Do not "restore the spec" here: `none` and `contain` both reintroduce the bug.**

---

## 9. The pens TV has a MEDICATION RED state the design does not describe — SAFETY, added 2026-08-25

The handoff's TV section (`README.md` section 6) enumerates the card states exhaustively —
`all` sage, `three-quarter`, `half` warm, `quarter` glow, `none` `#402310` + pen warning lamp —
and closes with "same information as today". **That list is now incomplete, and completing it
from the spec would delete a safety signal.**

The shipped pens TV additionally has:

- `--color-danger: #b42318` (plus `--color-danger-dark`, `--color-danger-text`) — the palette
  in the handoff is terracotta/sage only and has no danger colour at all.
- `.dog-card.has-rx` — the WHOLE tile goes red when the dog needs prescription medication.
- `.rx-badge` — a small white-on-red `MED` pill.
- `indicator-p` (the terracotta prescription pill) is SUPPRESSED on a red tile: dark brown on
  red is illegible at TV distance, and two marks for one fact teaches people to read neither.

**Do not "restore the spec" here.** A dog is red when the boarding plan declares
`feeding.medication === 'Yes'` OR staff have ticked `dog.prescription`. Kam chose whole-tile
red plus a short `MED` badge, deliberately with no medication detail text, because detail text
risks the pen auto-fit layout.

Two constraints the treatment must keep: it **recolours only** — no box dimension may change,
because `box-sizing: border-box` feeds `calculateScale()`; and it must **not** override
`border-left-color`, which is the portion/status channel every `.dog-card.status-*` rule owns.
Both are asserted by `tests/display-rx-red.smoke.mjs`.

## Still open

**~~The Android drag has never been exercised on a real tablet or phone.~~ CLOSED 2026-08-10:**
the owner exercised the live board on a real Android phone after the §8 overscroll fix and
confirmed vertical scroll, long-press drag between pens, and the sideways pen-row swipe all work
("great all seems to be fixed"). Staff tablets have also been on this engine in daily production
since @37 (2026-08-05) with no drag complaints. Emulated CDP-touch coverage now exists too
(`tests/android-scroll.smoke.mjs`), but the real-device pass is the one that counts — re-run it
after any change to the drag engine, tile CSS, or scroll behaviour.
