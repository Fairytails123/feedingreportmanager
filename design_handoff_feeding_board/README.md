# Handoff: Feeding Report Manager — tablet-first UI redesign

> ## ⚠️ THIS SPEC WAS IMPLEMENTED ON 2026-08-05 — READ `AS-BUILT.md` FIRST
>
> This file is preserved as the design **as delivered**, and it is still the source of truth for
> colours, sizes, spacing and copy. But the shipped UI deliberately differs from it in a handful
> of places — most importantly **the portion control is a `<select>`, not the 5-way segmented
> control described in §2** (owner decision, taken after using the first build: five side-by-side
> targets set a wide floor on the tile, which left **one pen on screen** in phone portrait).
>
> **`AS-BUILT.md` in this folder lists every difference and why.** Do not "restore" this spec over
> the implementation without reading it — several of those decisions were made after measuring the
> result on a real device or on the live board.

## Overview

A redesign of the **Feeding Report Manager** staff UI (`index.html`) and the **TV display**
(`display/display.html`) for the Fairy Tails dog daycare feeding round.

Nothing about the data model, the sync protocol, the submit pipeline or the n8n/Apps Script
contract changes. This is a **presentation-layer redesign** plus **one behavioural rewrite**: the
drag-and-drop engine, which is being replaced because the current one breaks on Android.

Goals, in priority order:

1. **Reliable drag-and-drop on Android** (the reported production failure).
2. **Tablet-first layout** — 10″ Android tablet in landscape is the primary device; Android phone
   in portrait is a real secondary device; desktop is a bonus.
3. Fewer taps for the job staff repeat 20× a round (setting the portion eaten).
4. Legibility of the TV display from across the room.

> **Read `INTEGRATION.md` before writing any code.** It lists the production behaviours that must
> survive this change, mapped to the functions that implement them. The existing repo has a
> documented history of green-test-suite regressions; that file is the guard rail.

---

## About the design files

The files in `designs/` are **design references**, not production code to copy wholesale.

- They are `.dc.html` files authored in a design tool. **They will not render if you just open them
  in a browser** — they need that tool's runtime.
- They are, however, **fully readable source**: every colour, size, radius and piece of copy is an
  inline style in the template, and the entire drag engine is plain JavaScript in the logic class.
  Read them as the authoritative source for exact values.
- The target codebase is a **single self-contained vanilla HTML file with inline CSS and JS, no
  framework and no bundler**. So this is *not* a React port. Recreate the design in the existing
  file, in the existing style, using the existing helper functions.
- `implementation/` contains two files written specifically for that target: a drop-in vanilla
  drag engine and a paste-ready token block. Start there.

## Fidelity

**High-fidelity.** Final colours, typography, spacing, radii, interaction states and copy. Recreate
it precisely. Where a value is not stated in this README, read it off the inline style in
`designs/Feeding Board.dc.html`.

## Visual direction

The design follows the **Organic** design system (warm cream ground, terracotta + sage accents,
Caprasimo display face over Figtree, large radii). Apple's *philosophy* is applied as behaviour —
one obvious action per surface, progressive disclosure, 44px minimum touch targets, motion that
explains what moved — not as Apple chrome. There are **no emoji**; icons are Lucide-style outlines
at `stroke-width: 2.75`.

`designs/styles.css` is the Organic token sheet the designs reference via `var(--*)`. Either link
it or paste `implementation/tokens.css` into `index.html`'s `:root` (recommended — the target is a
single self-contained file).

---

## Screens / views

There is **one screen** — the feeding board — that reflows across three widths, plus modal sheets
and a separate TV page. Layout switches are driven by **container queries on the board root**, not
viewport media queries, so the component is correct inside any wrapper.

| Breakpoint (container inline-size) | Shape |
|---|---|
| `≤ 719px` | Phone portrait: single column, pens swipe horizontally, staging + actions in a fixed bottom tray |
| `720px – 1059px` | Tablet portrait / small window: rail becomes a 2-column block above the pens; pens swipe |
| `≥ 1060px` | **Primary.** 312px left rail + all 10 pens visible in a 5-column grid, no horizontal scrolling |
| `≥ 1400px` | As above, rail 340px, gaps 20px |

### 1. Board — rail (`≥ 1060px`, left column, 312px, own vertical scroll)

Stacked cards, `background: var(--color-surface)` `#ebddc5`, `border-radius: 28px`, `padding: 14px`,
`box-shadow: var(--shadow-sm)`, `gap: 12px` between cards. Card headings are Caprasimo 15px.

1. **Add a dog** — text input (pill, `min-height: 48px`, `font-size: 16px` to stop iOS zoom,
   `background: var(--color-neutral-100)`) + circular terracotta `+` button (48×48).
   Typing shows up to 4 matching roster names as a vertical list of 44px-high buttons; Enter adds.
2. **Meal** — 3-way segmented control (Morning / Lunch / Evening) in a pill track
   (`background: var(--color-neutral-200)`, `padding: 5px`); the selected segment is a white pill
   (`var(--color-neutral-100)`) with `var(--shadow-sm)`. Below it, **Add today's dogs** — a full
   width pill button, 48px. **When the board is completely empty this button becomes the primary
   action**: terracotta fill, 56px tall, `var(--shadow-md)`.
3. **To assign** — heading + count tag, then the staging drop zone (`min-height: 96px`,
   `border-radius: 16px`, `2px dashed`, transparent border at rest). Then the **delete bin**:
   52px tall dashed pill, growing to 64px during a drag.
4. **Preview / Submit** — two pill buttons, 52px. Submit is sage (`var(--color-accent-2-600)`) when
   safe to submit and `var(--color-neutral-400)` when locked.

### 2. Board — pens (main column, own vertical scroll)

Two sections, **Top pens** and **Bottom pens**. Each: a Caprasimo 17px heading, a dog count, a hairline
rule, and a right-aligned capacity hint ("up to 3 dogs" / "up to 5 dogs"). Then the pen row —
`display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 12px` at ≥1060px, or a
horizontal snap-scroller below that.

**Pen** — `background: var(--color-surface)`, `border-radius: 28px`, `padding: 8px`,
`min-height: 148px` (a floor only; grid stretch equalises every pen in a row — do **not** reserve
`max dogs × tile height`, it wastes a third of the screen on a quiet day). Header row: Caprasimo
14px pen label, then a count badge (`var(--color-neutral-300)` pill, 24px). Empty pens show a dashed
"Empty" placeholder that becomes "Drop here" in accent while a dog is in the air.

**Dog tile** — the core component. `background: var(--color-neutral-100)` `#f9f4ed`,
`border: 1px solid var(--color-divider)`, `border-left: 5px solid <portion colour>`,
`border-radius: 16px`, `box-shadow: var(--shadow-sm)` (`var(--shadow-md)` when expanded),
`overflow: hidden`. Two rows collapsed:

- **Row 1** (44px min): the name (Figtree 700, 14.5px, ellipsised) as a button that expands the
  tile; then a 22px sage pill badge if supplements are set, a 22px terracotta pill badge if medicine
  is set, then a chevron that rotates 180° when expanded.
- **Row 2**: the portion control — `display: grid; grid-template-columns: repeat(4,1fr) 1.55fr;
  gap: 3px; padding: 0 5px 5px`. Five buttons, `min-height: 38px`, Caprasimo. Labels
  `All · ¾ · ½ · ¼ · None`; the first is 15px, "None" is 10.5px (it needs the extra column width —
  that is what the `1.55fr` is for). Unselected: `var(--color-neutral-200)` fill,
  `var(--color-neutral-800)` text, transparent border, radius `4px` except the outer two which are
  `99px 4px 4px 99px` / `4px 99px 99px 4px`. Selected: filled with the portion colour; text is
  `var(--color-neutral-900)` on the two light fills (¾, ½) and `var(--color-neutral-100)` on the
  other three.

Expanded (revealed under a `1px dashed` divider, animating in over 300ms):

- **Medicine** and **Supplements** toggle pills, 44px, side by side. Off:
  `var(--color-neutral-100)` on `var(--color-divider)`. Medicine on: `var(--color-accent-200)` fill,
  `var(--color-accent-800)` text, `var(--color-accent-400)` border. Supplements on: the
  `--color-accent-2-*` equivalents.
- If medicine is on: a "Which medicine?" text input, 46px, `font-size: 16px`.
- If supplements are on: four 40px chips — Calming / Hemp / Vitamins / Probiotics. Selected chips
  fill `var(--color-accent-2-600)` with `var(--color-neutral-100)` text.
- **Take off the board** — a ghost pill with a trash icon, `var(--color-accent-800)` text. Deliberately
  only reachable inside the expanded tile: a bare `×` on a collapsed tile is a mis-tap waiting to
  happen when tiles are 88px tall and fingers are wet.

### 3. Board — phone portrait (`≤ 719px`)

The rail is hidden. Pens become a horizontal snap-scroller (`scroll-snap-type: x mandatory`, each
pen `flex: 0 0 84%`). A **fixed bottom tray** carries, in order: the Add-a-dog input + `+` button;
matching-name chips as a horizontal row when typing; a row with "To assign" + count + a
lightning icon button (add today's dogs) + Submit; the staging strip as a horizontal scroller; and,
**only while dragging**, the delete bin. `.fb-main` gets `padding-bottom: 200px` so the tray never
covers the last pen.

### 4. Sheets (bottom sheets, not centre modals)

Full-width, `max-width: 560px`, bottom-anchored, `border-radius: 28px 28px 0 0`, over a
`var(--color-neutral-900)` 46% scrim, rising 14px on open.

- **Ready to submit** — title, subtitle (`<n> dogs · <meal> · goes to Telegram for review`), then
  one block per non-empty pen in canonical pen order, each dog as a row with name, an extras line
  (`Medicine: <text>` / supplement labels) and a portion pill. If any dogs are still unassigned, a
  sage note says they will not be included. Footer: "Keep editing" / "Submit report".
- **Today's dogs** — a spinner and the honest copy *"Reading today's whiteboard. This can take up to
  45 seconds — it's the slow one."*, then two result blocks: **Added to the board** and
  **Skipped — no pen on the master sheet** (with the reason per row). Footer: "Cancel" / "Add them".

### 5. Connection states

A pill in the header, always visible: sage "All saved", neutral "Syncing n…" with a pulsing dot, or
terracotta "Offline".

**Offline** additionally shows a banner at the top of the board (`var(--color-accent-800)` →
`var(--color-accent-700)` gradient): a pulsing warning lamp, *"Not synced — n changes waiting"*,
the reassurance *"Your edits are safe on this tablet. Submit is locked until they land."*, and a
**Retry now** button. It **pushes the board down** (the board's top padding goes 14px → 86px)
rather than covering it.

### 6. TV display (`designs/Feeding TV Display.dc.html`)

> ⚠️ **The card states below are NO LONGER the complete list, and completing them from this
> section would delete a safety signal.** The shipped pens TV adds a MEDICATION RED state
> (`--color-danger`, `.dog-card.has-rx`, a `MED` badge, and suppression of the duplicate
> terracotta pill) that this spec never described. **Read `AS-BUILT.md` section 9 before
> changing any TV card styling.** This pointer is here because the banner at the top of this
> file is a single point of failure — anyone linked straight to this section never sees it.

A separate full-screen page. Same information as today: 10 pens in two rows, per-dog portion, the
medicine/supplement flags, the footer counts, and the NOT LIVE staleness banner with the stale board
still visible behind it.

**The organising idea: a car dashboard at night. A clean bowl is dim; a problem glows.**

- Ground: `radial-gradient(125% 95% at 50% -12%, #2e2b25, #201e1d)` — warm dark, never grey.
- A dog that ate everything: `#2e2b25` card, sage `#728157` left edge, `var(--color-neutral-300)`
  name, `var(--color-neutral-600)` status. Deliberately quiet.
- `½` warms up (`#332b23` card, `var(--color-accent-400)` edge). `¼` brighter still with a soft
  glow. **`None`** gets a `#402310` card, a `#ffc6a5` edge, near-white text and a slow 2.6s amber
  glow pulse — and **its pen lights a warning lamp beside the pen name**, so a refusal is findable
  from the doorway without reading a word.
- **Every size is in `cqh`** (1% of the display's own height) so one page fits the 32″ 1366×768 set,
  1080p and 4K identically. Not `vh` — `cqh` stays correct inside a frame.
- The five scale tiers from the current display are kept, keyed on the busiest pen
  (`≤2 / ≤3 / ≤4 / ≤6 / more`), just re-expressed in `cqh`. See `TIERS` in the logic class.
- Footer: the portion legend, then **Dogs / Pens / Need a look / Updated**. "Need a look" counts
  refusals plus quarters and turns terracotta when non-zero — the only number anyone must act on.
  There is deliberately **no progress bar**: staff feed in sequence and told us it is not useful.

---

## Interactions & behaviour

### Drag and drop — read `implementation/drag-engine.js`

This is the part being rewritten. Summary of the intended behaviour:

- **Long-press anywhere on a tile (300ms) picks the dog up.** There is no separate drag handle —
  that was tried and rejected. The portion control and the expanded panel are the only opt-outs
  (marked `data-nodrag`), because an accidental lift while aiming for "½" is worse than a slightly
  smaller drag surface.
- Moving more than 10px before the press lands **cancels** it — that gesture was a scroll.
- While pressed but not yet lifted the tile is *armed*: `transform: scale(.975)` and a 3px
  `var(--color-accent-300)` ring. It is written straight to the DOM, not through a re-render.
- On lift: a haptic tick, the source tile drops to `opacity: .35` and desaturates, and a floating
  ghost appears — the dog's name, a terracotta left edge, `var(--shadow-lg)`, rotated `-1.5deg` and
  scaled `1.03`, with a right-aligned hint pill naming the current target ("Bottom 2" / "Remove" /
  "Un-assign").
- The hovered pen gets `var(--color-accent-200)` fill and a 3px accent ring; a 3px accent
  **insertion line** shows exactly where the dog will land between tiles.
- **Dragging near an edge pans the board**, proportionally to how far past the edge you push, and it
  keeps panning while you hold there. On a phone this is how you carry a dog from Top 1 to Top 5.
  Scroll snapping is disabled for the duration.
- Drop on a pen → move (at the insertion index). On the staging area → un-assign. On the bin →
  remove, with a distinct haptic pattern.
- **Keyboard equivalent**: tiles are focusable; Space picks up, arrows move between pens and within
  a pen, Enter drops, Escape cancels. An `aria-live` region announces each step.

### Other interactions

- Tapping a tile's name row toggles the expanded panel. A tap within 320ms of a drag ending is
  swallowed, so releasing a drag never also expands the tile.
- Setting a portion, toggling medicine/supplements and editing text all fire immediately and show a
  toast naming what changed.
- Toasts: `var(--color-neutral-900)` pill, bottom-centre, 2.2s, rising 150px while dragging so the
  drag ghost and the toast never fight.
- `prefers-reduced-motion: reduce` disables every animation.

### Animation reference

| What | Duration / easing |
|---|---|
| Tile expand, sheet open | 300ms `cubic-bezier(.22,1,.36,1)` |
| Toast in | 220ms `cubic-bezier(.22,1,.36,1)` |
| Drop-target highlight, meal segment | 160–180ms `ease` |
| Newly-added tile flash | 900ms `ease-out`, `--color-accent-200` → `--color-neutral-100` |
| Offline lamp / stale lamp pulse | 1.5s `ease-in-out` infinite |
| TV refusal glow | 2.6s `ease-in-out` infinite |
| Armed tile | 120ms `ease` |

---

## State

No new persistent state. Per dog the design reads exactly what the Session row already carries:
`id`, resolved `name`, `pen`, `position` (array order within the pen), `status`, `prescription` +
`prescriptionComment`, `supplements` + `supplementTypes[]`, and the unresolved-name fields
(`inputName`, `possibleMatches[]`). Board-level: `mealType`, plus the existing `isOnline` /
`mutationQueue.length` for the connection pill and the Submit gate.

New **view-only** state, none of it synced: which tile is expanded (one at a time), the current drag
(`{id, fromPen, name, width}`), the current drop target and insertion index, the keyboard "lifted"
tile, which sheet is open, and the current toast.

**The "not yet reviewed" idea was explicitly rejected** by the client — do not add it. Every dog
starts on `All` and shows a solid portion colour, exactly as today.

---

## Design tokens

Paste `implementation/tokens.css` into `index.html`'s `:root`. The values, for reference:

**Ground and surfaces** — bg `#f5ead8`, surface `#ebddc5`, card `#f9f4ed`, text `#201e1d`,
divider `color-mix(in srgb, #201e1d 16%, transparent)`.

**Neutral ramp** — 100 `#f9f4ed`, 200 `#eee7db`, 300 `#dcd3c4`, 400 `#c0b6a5`, 500 `#a19786`,
600 `#82796a`, 700 `#645c50`, 800 `#474238`, 900 `#2e2b25`.

**Terracotta ramp** — 100 `#fff2eb`, 200 `#ffe1d0`, 300 `#ffc6a5`, 400 `#f6a06b`, 500 `#d67f48`,
base `#c67139`, 600 `#b2622d`, 700 `#8c491a`, 800 `#643312`, 900 `#402310`.

**Sage ramp** — 100 `#f0fae1`, 200 `#e1eecc`, 300 `#ccdbb2`, 400 `#aebf92`, 500 `#8fa073`,
base `#7a8a5e`, 600 `#728157`, 700 `#56633f`, 800 `#3d472b`, 900 `#272e1b`.

**Portion colours (light UI)** — All `#728157`, ¾ `#aebf92`, ½ `#f6a06b`, ¼ `#b2622d`,
None `#643312`.

**Portion colours (TV, dark ground)** — All `#728157`, ¾ `#aebf92`, ½ `#f6a06b`, ¼ `#ffc6a5`,
None `#ffc6a5` on a `#402310` card.

**Type** — headings `Caprasimo` 400; body/UI `Figtree` 400/600/700. Google Fonts:
`https://fonts.googleapis.com/css2?family=Caprasimo:wght@400&family=Figtree:wght@400;600;700&display=swap`.
This **replaces Nunito**; drop the old font link.

**Spacing** — 4.4 / 8.8 / 13.2 / 17.6 / 26.4 / 35.2px. **Radii** — 8 / 16 / 28px, and `999px` for
pills. **Shadows** — sm `0 1px 2px` / md `0 3px 10px` / lg `0 12px 32px`, all
`color-mix(in srgb, #2e2b25 14–22%, transparent)`.

**Minimum touch target is 44px** everywhere. Inputs are `font-size: 16px` so iOS does not zoom.

---

## Assets

**None.** No images, no icon font, no sprite sheet. Every icon is an inline SVG in the design
source — Lucide-style outlines, `stroke-width: 2.75`, `stroke-linecap: round`, sized 13–24px, using
`currentColor`. Copy the SVGs straight out of `designs/Feeding Board.dc.html`.

The current `index.html` loads a logo from `https://i.ibb.co/whdBKp0L/Logo-1.jpg`. The redesign uses
a sage circular bowl glyph in its place. If you want the real logo back, drop it into that 44px
circle — but note the current URL is a third-party image host and is a production dependency worth
removing.

---

## Files in this bundle

```
README.md                          this file — the design spec
screenshots/                       rendered reference images (see note below)
INTEGRATION.md                     what must not break, and the order to do it in
implementation/drag-engine.js      drop-in vanilla drag engine for index.html
implementation/tokens.css          paste-ready :root token block
designs/Feeding Board.dc.html      the board — authoritative source for values + engine
designs/Feeding TV Display.dc.html the TV display
designs/Feeding Board Redesign.dc.html  review canvas: both designs framed at device sizes,
                                   plus the written design rationale
designs/styles.css                 the Organic design-system token sheet
```

### Screenshots

`screenshots/` holds rendered references, since the `.dc.html` files will not open in a plain
browser:

- `01-board-tablet-landscape.png` — the primary screen, 1284×800, busy board (20 dogs)
- `02-board-phone-portrait.png` — 412px wide, pens swiping, bottom tray
- `03-tv-display-live.png` — the TV display, normal lunch with one refusal in Top 5

They are references for layout and colour, not measurements — take exact values from this README and
from the inline styles in the design source.
