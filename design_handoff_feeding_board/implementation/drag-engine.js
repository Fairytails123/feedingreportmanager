/**
 * FRM drag engine — drop-in replacement for the touch/mouse drag code in index.html
 * ---------------------------------------------------------------------------------
 * Plain ES5-era JavaScript, no framework, no build step, matching the target file's
 * existing style. Paste inside index.html's inline <script>, then call
 * FRMDrag.init() from setupEventListeners() and DELETE the old handlers:
 *
 *   handleTouchStart, checkTouchScroll, cancelTouchDrag, startDragTouch,
 *   handleTouchMove, handleTouchEnd, handleMouseDown, checkMouseScroll,
 *   cancelMouseDrag, startDragMouse, handleMouseMove, handleMouseUp,
 *   updateDropTargetHighlight, createGhostElement, removeGhostElement,
 *   handlePenEnter/Leave, handleBinEnter/Leave, handleStagingEnter/Leave
 *
 * KEEP and reuse (this engine calls them): computeDropIndex, moveDogToPen,
 * deleteDog, showDropZones, hideDropZones, showDropIndicator, clearDropIndicator,
 * triggerHaptic, showToast, getDogDisplayName.
 *
 * Also required, in CSS:
 *   - DELETE  body.is-dragging { overflow: hidden; touch-action: none; }
 *   - REMOVE  touch-action: none  from .pen-dog-name / .dog-card
 *   - ADD     .pen-dog, .dog-card { touch-action: pan-y; user-select: none;
 *                                   -webkit-user-select: none;
 *                                   -webkit-touch-callout: none; }
 *   - ADD     body.is-dragging .pen-dog, body.is-dragging .dog-card { touch-action: none; }
 *   - ADD     .pen-row-scroll, .pen-dogs, .staging-area { }  // see SNAP note below
 *   - ADD     body.is-dragging .pen-row-scroll { scroll-snap-type: none; scroll-behavior: auto; }
 *   - ADD     .drag-ghost { pointer-events: none; will-change: transform; transform-origin: top left; }
 *   - ADD     [data-armed="true"] { transform: scale(.975); box-shadow: 0 0 0 3px var(--color-accent-300); }
 *
 * Markup expectations (all already true in index.html except the last two):
 *   - drop zones:  .pen[data-pen-id]        → move
 *                  #deleteBin               → delete
 *                  #stagingArea             → un-assign
 *   - draggables:  .pen-dog[data-dog-id]    (in a pen)
 *                  .dog-card[data-dog-id]   (in staging)
 *   - NEW: add data-nodrag="true" to the portion control and to the expanded
 *     prescription/supplement panel, so a press there never lifts the dog.
 *   - NEW: the whole tile is the drag surface. The [data-draggable="true"] handle
 *     span can be deleted.
 *
 * WHY THIS FIXES ANDROID — three specific causes, all removed:
 *
 *   1. The non-passive `touchmove` listener is registered ONCE AT INIT, not when a
 *      drag starts. Chrome decides whether a gesture is a scroll on its first moves;
 *      a listener attached 300ms later can no longer cancel one. Registered up
 *      front, every move after the press lands is cancelled at source.
 *   2. `setPointerCapture` is taken WHEN THE DRAG STARTS (not on pointerdown), so
 *      moves keep arriving at the same element even when the pen re-renders, the
 *      list reflows, or the finger leaves the pen — and taps on buttons inside a
 *      tile still work, because capturing on pointerdown retargets pointerup and
 *      kills the click.
 *   3. No `body { overflow: hidden }`. That lock is what makes the page jump under
 *      the finger on Android. Scrolling is prevented by cancelling touchmove, and
 *      the board auto-scrolls at the edges instead, so an off-screen pen is
 *      reachable in one gesture.
 *
 * SNAP note: any scroll container that uses scroll-snap must have snapping disabled
 * while dragging, or every programmatic scroll is yanked back to the nearest pen.
 */

var FRMDrag = (function () {
    'use strict';

    var LONG_PRESS_MS   = 300;   // hold before a touch becomes a drag
    var SCROLL_CANCEL_PX = 10;   // movement before the press lands = it was a scroll
    var CLICK_SUPPRESS_MS = 320; // ignore the click that follows a completed drag
    var EDGE = 84;               // auto-scroll trigger zone, px from a scroller's edge
    var MAX_SPEED = 24;          // auto-scroll px per frame at full push
    var EDGE_PAD = 48;           // tolerance when testing if the pointer is beside a scroller

    var press = null;      // {dogId, fromPen, pointerId, sx, sy, ox, oy, w, handle, tile}
    var drag = null;       // {dogId, fromPen}
    var pt = null;         // latest pointer position, client coords
    var ghost = null;
    var raf = null;
    var timer = null;
    var scrollers = null;  // measured once at lift
    var over = null;       // {kind:'pen'|'bin'|'stage', id, index}
    var suppressClickUntil = 0;

    // ---------------------------------------------------------------- helpers

    function isDragging() { return !!drag; }

    function clearTimer() {
        if (timer) { clearTimeout(timer); timer = null; }
    }

    function armedOn(el)  { if (el && el.setAttribute) el.setAttribute('data-armed', 'true'); }
    function armedOff(el) { if (el && el.removeAttribute) el.removeAttribute('data-armed'); }

    function unbind() {
        if (!press || !press.handle) return;
        press.handle.removeEventListener('pointermove', onMove);
        press.handle.removeEventListener('pointerup', onUp);
        press.handle.removeEventListener('pointercancel', onCancel);
        press.handle.removeEventListener('pointerleave', onLeave);
        try { press.handle.releasePointerCapture(press.pointerId); } catch (e) {}
    }

    // Every scroller the board owns, measured once at lift. Walking up from
    // elementFromPoint each frame fails in the case that matters most on a phone:
    // once the finger is at the very edge of the screen (or past it) there may be no
    // element under it — and that is exactly when the row has to keep moving.
    function collectScrollers() {
        var nodes = document.querySelectorAll('.pen-row-scroll, .main-content, .container, .staging-area');
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (n.scrollWidth <= n.clientWidth + 2 && n.scrollHeight <= n.clientHeight + 2) continue;
            var st = window.getComputedStyle(n);
            out.push({
                el: n,
                x: /auto|scroll/.test(st.overflowX),
                y: /auto|scroll/.test(st.overflowY)
            });
        }
        // the document itself, so a drag can pan the whole page vertically
        out.push({ el: document.scrollingElement || document.documentElement, x: false, y: true });
        return out;
    }

    // ---------------------------------------------------------------- ghost

    function makeGhost(dogId, x, y) {
        killGhost();
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        ghost.style.position = 'fixed';
        ghost.style.left = '0';
        ghost.style.top = '0';
        ghost.style.zIndex = '10000';
        ghost.style.pointerEvents = 'none';
        ghost.style.willChange = 'transform';
        ghost.style.transformOrigin = 'top left';
        ghost.style.width = Math.max(150, Math.min(240, press.w)) + 'px';

        var name = document.createElement('span');
        name.textContent = (typeof getDogDisplayName === 'function') ? getDogDisplayName(dogId) : dogId;
        var hint = document.createElement('span');
        hint.className = 'drag-ghost-hint';
        ghost.appendChild(name);
        ghost.appendChild(hint);

        document.body.appendChild(ghost);
        moveGhost(x, y);
    }

    function moveGhost(x, y) {
        if (!ghost || !press) return;
        ghost.style.transform =
            'translate3d(' + (x - press.ox) + 'px,' + (y - press.oy) + 'px,0) rotate(-1.5deg) scale(1.03)';
    }

    function setGhostHint(text) {
        if (!ghost) return;
        var h = ghost.querySelector('.drag-ghost-hint');
        if (h) h.textContent = text || '';
    }

    function killGhost() {
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        ghost = null;
        var stale = document.querySelectorAll('.drag-ghost');
        for (var i = 0; i < stale.length; i++) stale[i].parentNode.removeChild(stale[i]);
    }

    // ---------------------------------------------------------------- hit test

    // elementFromPoint (the ghost is pointer-events:none) so hit testing stays
    // correct under CSS transforms, zoom and mid-drag auto-scroll.
    function hitTest(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el || !el.closest) return null;
        if (el.closest('#deleteBin') || el.closest('.bin')) return { kind: 'bin', id: 'bin', index: null };
        var pen = el.closest('.pen');
        if (pen) {
            return {
                kind: 'pen',
                id: pen.getAttribute('data-pen-id'),
                index: (typeof computeDropIndex === 'function')
                    ? computeDropIndex(pen, drag ? drag.dogId : null, y)
                    : undefined
            };
        }
        if (el.closest('#stagingArea') || el.closest('.staging-section')) {
            return { kind: 'stage', id: 'stage', index: null };
        }
        return null;
    }

    function penLabel(penId) {
        return penId.replace('-', ' ').replace(/\b\w/g, function (l) { return l.toUpperCase(); });
    }

    function paintTarget(hit) {
        var prev = document.querySelectorAll('.drag-over');
        for (var i = 0; i < prev.length; i++) prev[i].classList.remove('drag-over');
        if (typeof clearDropIndicator === 'function') clearDropIndicator();

        if (!hit) { setGhostHint(''); return; }
        if (hit.kind === 'bin') {
            var bin = document.getElementById('deleteBin');
            if (bin) bin.classList.add('drag-over');
            setGhostHint('Remove');
        } else if (hit.kind === 'stage') {
            var st = document.getElementById('stagingArea');
            if (st) st.classList.add('drag-over');
            setGhostHint('Un-assign');
        } else if (hit.kind === 'pen') {
            var pen = document.querySelector('.pen[data-pen-id="' + hit.id + '"]');
            if (pen) {
                pen.classList.add('drag-over');
                if (typeof showDropIndicator === 'function') showDropIndicator(pen, pt.y);
            }
            setGhostHint(penLabel(hit.id));
        }
    }

    // ---------------------------------------------------------------- auto-scroll

    // Proportional so a nudge creeps and a firm push races; anything past the edge
    // (dist < 0) is already at full speed.
    function ramp(dist) {
        return Math.ceil(MAX_SPEED * Math.min(1, Math.max(0, EDGE - dist) / EDGE));
    }

    function autoScroll(x, y) {
        if (!scrollers) return;
        for (var i = 0; i < scrollers.length; i++) {
            var s = scrollers[i], n = s.el, r;
            if (n === document.documentElement || n === document.body || n === document.scrollingElement) {
                r = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
                      width: window.innerWidth, height: window.innerHeight };
            } else {
                r = n.getBoundingClientRect();
            }
            if (!r.width || !r.height) continue;

            if (s.x && n.scrollWidth > n.clientWidth + 2 && y > r.top - EDGE_PAD && y < r.bottom + EDGE_PAD) {
                if (x < r.left + EDGE) n.scrollLeft -= ramp(x - r.left);
                else if (x > r.right - EDGE) n.scrollLeft += ramp(r.right - x);
            }
            if (s.y && n.scrollHeight > n.clientHeight + 2 && x > r.left - EDGE_PAD && x < r.right + EDGE_PAD) {
                if (y < r.top + EDGE) n.scrollTop -= ramp(y - r.top);
                else if (y > r.bottom - EDGE) n.scrollTop += ramp(r.bottom - y);
            }
        }
    }

    // ---------------------------------------------------------------- frame loop

    // ONE persistent rAF for the whole drag, not one scheduled per move. A finger
    // parked in the edge zone stops producing pointermove events, so a move-driven
    // loop would stop scrolling exactly when the user is asking it to keep going.
    function loop() {
        raf = null;
        if (!drag || !pt) return;
        moveGhost(pt.x, pt.y);
        var hit = hitTest(pt.x, pt.y);           // hit-test BEFORE scrolling, or we
        autoScroll(pt.x, pt.y);                  // read whatever slid under the finger
        var changed = !over !== !hit ||
            (over && hit && (over.kind !== hit.kind || over.id !== hit.id || over.index !== hit.index));
        if (changed) {
            if (hit && hit.kind === 'pen' && (!over || over.id !== hit.id)) triggerHaptic('light');
            over = hit;
            paintTarget(hit);
        }
        raf = requestAnimationFrame(loop);
    }

    // ---------------------------------------------------------------- gesture

    function onPointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (drag || press) return;                       // pointerdown bubbles — first one wins
        if (e.target.closest && e.target.closest('[data-nodrag]')) return;

        var tile = e.target.closest ? e.target.closest('.pen-dog, .dog-card') : null;
        if (!tile) return;
        var dogId = tile.getAttribute('data-dog-id');
        if (!dogId) return;
        var penEl = tile.closest('.pen');
        var rect = tile.getBoundingClientRect();

        press = {
            dogId: dogId,
            fromPen: penEl ? penEl.getAttribute('data-pen-id') : null,
            pointerId: e.pointerId,
            sx: e.clientX,
            sy: e.clientY,
            ox: e.clientX - rect.left,               // grab offset keeps the ghost under
            oy: e.clientY - rect.top,                // the exact spot that was touched
            w: rect.width,
            handle: tile,
            tile: tile
        };

        // NO pointer capture yet — see the header note. Capture on pointerdown
        // retargets pointerup and the browser then resolves the click against the
        // tile instead of the button inside it, which kills every tap on a tile.
        tile.addEventListener('pointermove', onMove);
        tile.addEventListener('pointerup', onUp);
        tile.addEventListener('pointercancel', onCancel);
        tile.addEventListener('pointerleave', onLeave);

        armedOn(tile);
        clearTimer();
        timer = setTimeout(lift, LONG_PRESS_MS);
    }

    function lift() {
        if (!press) return;
        clearTimer();
        armedOff(press.tile);
        try { press.handle.setPointerCapture(press.pointerId); } catch (e) {}

        drag = { dogId: press.dogId, fromPen: press.fromPen };
        pt = { x: press.sx, y: press.sy };
        over = null;

        document.body.classList.add('is-dragging');
        press.tile.classList.add('dragging');
        triggerHaptic('medium');

        makeGhost(press.dogId, pt.x, pt.y);
        if (typeof showDropZones === 'function') showDropZones();
        announce((typeof getDogDisplayName === 'function' ? getDogDisplayName(press.dogId) : 'Dog') +
                 ' picked up. Drag to a pen.');

        scrollers = collectScrollers();
        if (!raf) raf = requestAnimationFrame(loop);
    }

    function onMove(e) {
        if (!press || e.pointerId !== press.pointerId) return;
        if (!drag) {
            // Still deciding: a real finger-slide before the press lands is a scroll.
            if (Math.abs(e.clientX - press.sx) > SCROLL_CANCEL_PX ||
                Math.abs(e.clientY - press.sy) > SCROLL_CANCEL_PX) abort();
            return;
        }
        e.preventDefault();
        pt = { x: e.clientX, y: e.clientY };
    }

    function onLeave() { if (!drag) abort(); }
    function onCancel(e) { finish(e, true); }
    function onUp(e) { finish(e, false); }

    function finish(e, cancelled) {
        var p = press;
        clearTimer();
        if (p) armedOff(p.tile);
        unbind();
        if (!drag) { press = null; return; }

        document.body.classList.remove('is-dragging');
        var dragging = document.querySelectorAll('.dragging');
        for (var i = 0; i < dragging.length; i++) dragging[i].classList.remove('dragging');
        var hl = document.querySelectorAll('.drag-over');
        for (var j = 0; j < hl.length; j++) hl[j].classList.remove('drag-over');
        if (typeof clearDropIndicator === 'function') clearDropIndicator();
        if (typeof hideDropZones === 'function') hideDropZones();
        killGhost();

        suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;

        // Hit-test FRESH at the release point. The highlight comes from the last
        // animation frame, which can be a frame behind the finger (or never ran, if
        // the gesture was faster than one frame) — trusting it drops the dog in the
        // wrong pen. On pointercancel there are no useful coordinates, so fall back
        // to the last seen target: an interrupted gesture must still land the move.
        var target = over;
        if (!cancelled && e && typeof e.clientX === 'number') {
            var fresh = hitTest(e.clientX, e.clientY);
            if (fresh) target = fresh;
            else if (pt) { var f2 = hitTest(pt.x, pt.y); if (f2) target = f2; }
        }

        var dogId = p ? p.dogId : null;
        var fromPen = drag.fromPen;
        drag = null; press = null; pt = null; scrollers = null; over = null;
        if (raf) { cancelAnimationFrame(raf); raf = null; }

        if (!dogId || !target) { announce('Move cancelled'); return; }

        if (target.kind === 'bin') {
            triggerHaptic('delete');
            deleteDog(dogId);
        } else if (target.kind === 'pen') {
            triggerHaptic('success');
            moveDogToPen(dogId, target.id, target.index);
            showToast('Moved to ' + penLabel(target.id), 'success');
        } else if (target.kind === 'stage') {
            if (fromPen) {
                triggerHaptic('light');
                moveDogToPen(dogId, null);
                showToast('Returned to staging', 'info');
            }
        }
    }

    function abort() {
        clearTimer();
        if (press) armedOff(press.tile);
        unbind();
        press = null;
    }

    // ---------------------------------------------------------------- keyboard

    // Space picks up, arrows move between pens and within a pen, Enter drops,
    // Escape cancels. Give each tile tabindex="0" and role="button".
    var lifted = null;

    function onKeyDown(e) {
        var tile = e.target.closest ? e.target.closest('.pen-dog, .dog-card') : null;
        if (!tile) return;
        var dogId = tile.getAttribute('data-dog-id');
        var penEl = tile.closest('.pen');
        var penId = penEl ? penEl.getAttribute('data-pen-id') : null;

        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (lifted === dogId) { lifted = null; announce('Dropped'); }
            else { lifted = dogId; announce(getDogDisplayName(dogId) + ' picked up. Arrow keys to move, Enter to drop.'); }
            return;
        }
        if (lifted !== dogId) return;
        if (e.key === 'Escape') { lifted = null; announce('Move cancelled'); return; }

        var order = (typeof PEN_ORDER !== 'undefined') ? PEN_ORDER : [];
        var cur = order.indexOf(penId);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            var next = order[Math.max(0, Math.min(order.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))];
            if (next) moveDogToPen(dogId, next);
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && penId) {
            e.preventDefault();
            var list = pens[penId] || [];
            var at = list.indexOf(dogId);
            moveDogToPen(dogId, penId, Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
        }
    }

    function announce(msg) {
        var el = document.getElementById('dragLiveRegion');
        if (el) el.textContent = msg;
    }

    // ---------------------------------------------------------------- init

    function init() {
        // THE ANDROID FIX: registered once, up front, non-passive. A listener
        // attached mid-gesture cannot cancel a scroll Chrome has already committed to.
        document.addEventListener('touchmove', function (e) {
            if (drag) e.preventDefault();
        }, { passive: false });

        document.addEventListener('pointerdown', onPointerDown, { passive: true });
        document.addEventListener('keydown', onKeyDown);

        // Suppress the click that follows a completed drag, so releasing a drag
        // never also toggles the tile it landed on.
        document.addEventListener('click', function (e) {
            if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
        }, true);

        // Kill the native long-press menu on tiles (Android shows Download/Share/Print).
        document.addEventListener('contextmenu', function (e) {
            if (e.target.closest && e.target.closest('.pen-dog, .dog-card')) e.preventDefault();
        }, { passive: false });

        // aria-live region for the keyboard path
        if (!document.getElementById('dragLiveRegion')) {
            var lr = document.createElement('div');
            lr.id = 'dragLiveRegion';
            lr.setAttribute('aria-live', 'polite');
            lr.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
            document.body.appendChild(lr);
        }
    }

    return { init: init, isDragging: isDragging };
}());
