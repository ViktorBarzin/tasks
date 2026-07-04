/**
 * Svelte action: drag-to-reorder for a column of rows (iOS Reminders Edit
 * mode), touch-first with desktop mouse/pen semantics. Pointer Events only —
 * no HTML5 drag API (`dragstart` inside the container is always
 * defaultPrevented so no native drag ghost can start).
 *
 * Contract with the markup:
 *  - the action sits on the rows' CONTAINER; direct children carrying
 *    `data-drag-item` are the reorderable rows, in visual order;
 *  - the grab affordance inside a row carries `data-drag-handle` and MUST have
 *    `touch-action: none` in CSS (it has to hold at gesture start — inline
 *    writes from pointerdown are too late for the current touch);
 *  - while a drag is live the container gets `.drag-reorder-active` and the
 *    lifted row `.drag-lifted` (lift styling — shadow/z-index — lives in CSS;
 *    the action drives transforms/transitions inline), and a document-level
 *    style forces `cursor: grabbing` + no text selection everywhere (desktop
 *    affordance; removed on drop/cancel).
 *
 * Two ways to engage (primary button only):
 *  - HANDLE (Edit mode): pointerdown on `[data-drag-handle]` grabs immediately
 *    for EVERY pointer type;
 *  - ROW BODY (`liftOnHold`): pointerType-aware via holdGesture.ts.
 *    TOUCH — native Reminders behavior: pointerdown anywhere on a
 *    `[data-drag-item]` starts a ~350ms hold. Rows keep `touch-action: pan-y`,
 *    so the page scrolls natively until the lift: >8px of pre-lift travel
 *    cancels the hold (it was a scroll) and a pointercancel means the native
 *    pan claimed the touch. Only when the hold FIRES does the action own the
 *    gesture — pointer capture plus the non-passive `touchmove` blocker added
 *    at lift time preventDefault the still-cancelable touch stream (the finger
 *    held still, so WebKit hasn't committed to a scroll).
 *    MOUSE/PEN — classic desktop DnD, no hold: the row lifts as soon as the
 *    pressed pointer travels >~5px; a press that never crosses it stays a
 *    plain click (release → the row's tap action proceeds), however long it
 *    was held.
 *    In both modes a lifted gesture's click is swallowed by a capture-phase
 *    listener so the row's tap action (navigation) never runs; `contextmenu`
 *    inside the container is always defaultPrevented (no callout / context UI
 *    on long-press).
 *
 * Mechanics (mobile-first, zero layout thrash):
 *  - geometry is snapshotted ONCE at grab (content-space row boxes + the
 *    scroller viewport); after that the drag never reads layout — the rAF
 *    loop only reads `scrollTop` and writes `transform`;
 *  - pointer capture goes to the container so the drag survives row
 *    re-renders; `pointermove` merely records the finger — a continuous rAF
 *    loop does the math (index via `reorderMath`, pure + unit-tested);
 *  - the lifted row follows the finger via `translateY` (plus a small lift
 *    scale); siblings step aside via transitioned transforms (~150ms);
 *  - near the scroller's edges the loop auto-scrolls (accelerating) and folds
 *    the scrolled distance into the drag, so transforms stay consistent;
 *  - during the drag a non-passive `touchmove` blocker on the container
 *    prevents-and-stops the touch stream: the page can't scroll and ancestor
 *    touch handlers (pull-to-refresh) never see the gesture;
 *  - drop with a changed index: transforms are cleared with transitions
 *    suppressed and `onreorder(from, to)` runs inside `flushSync`, so the
 *    keyed re-render and the transform reset paint as ONE frame (no flash).
 *    A no-op drop glides the row back instead. Row order changing underneath
 *    (a sync landing mid-drag) cancels the drag cleanly.
 */
import { flushSync } from 'svelte';

import { createHoldGesture } from './holdGesture';
import {
	applyReorder,
	clampDy,
	edgeScrollVelocity,
	siblingShift,
	targetIndexFor,
	type RowBox
} from './reorderMath';

export { applyReorder };

export interface DragReorderOptions {
	enabled: boolean;
	/** Drop with a changed index — indices refer to the pre-drag row order. */
	onreorder: (from: number, to: number) => void;
	/** Scrolling ancestor for edge auto-scroll; defaults to the nearest overflow-y auto/scroll ancestor. */
	scroller?: () => HTMLElement | null;
	/** Long-press anywhere on a row lifts it — no handle, no Edit mode (Reminders parity). */
	liftOnHold?: boolean;
}

const SETTLE_MS = 180;
const LIFT_TRANSFORM = ' scale(1.03)';
const SIBLING_TRANSITION = 'transform 0.15s ease';
/** The lifted row's transform must track the finger raw; only its lift shadow eases in. */
const LIFTED_TRANSITION = 'box-shadow 0.15s ease';

interface LiveDrag {
	pointerId: number;
	items: HTMLElement[];
	rows: RowBox[];
	from: number;
	to: number;
	startY: number;
	startScroll: number;
	lastY: number;
	dy: number;
	/** Last applied sibling shift (units of siblingShift) per index. */
	applied: number[];
	scroller: HTMLElement | null;
	viewTop: number;
	viewBottom: number;
	raf: number;
	observer: MutationObserver;
}

function findScroller(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const overflowY = getComputedStyle(p).overflowY;
		if (overflowY === 'auto' || overflowY === 'scroll') return p;
	}
	return null;
}

/** Document-wide live-drag styling (desktop affordance): `cursor: grabbing`
 * over EVERYTHING (element cursors like the rows' `grab`/`pointer` would win
 * over an inherited value, hence the `!important` rule) and no text selection
 * anywhere the pointer strays. One shared <style> node, attached only while a
 * drag is live; inert for touch (no cursor, selection already off). */
let dragStyleEl: HTMLStyleElement | null = null;
function setDocumentDragStyle(on: boolean): void {
	if (!on) {
		dragStyleEl?.remove();
		return;
	}
	if (!dragStyleEl) {
		dragStyleEl = document.createElement('style');
		dragStyleEl.textContent =
			'* { cursor: grabbing !important; user-select: none !important; -webkit-user-select: none !important; }';
	}
	if (!dragStyleEl.isConnected) document.head.appendChild(dragStyleEl);
}

export function dragReorder(node: HTMLElement, options: DragReorderOptions) {
	let opts = options;
	let live: LiveDrag | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let settling: HTMLElement[] = [];

	/** Finish a pending no-op glide NOW (so a fresh grab measures true geometry). */
	function finishSettle(): void {
		if (settleTimer !== null) clearTimeout(settleTimer);
		settleTimer = null;
		for (const el of settling) {
			el.style.transition = '';
			el.style.transform = '';
			el.style.willChange = '';
			el.classList.remove('drag-lifted');
		}
		settling = [];
	}

	function blockTouch(e: TouchEvent): void {
		if (!live) return;
		// Own the gesture outright: no native pan, and no ancestor touch handler
		// (the scroller's pull-to-refresh) may interpret it.
		if (e.cancelable) e.preventDefault();
		e.stopPropagation();
	}

	// --- Long-press-to-lift (liftOnHold): the pending press being timed. ---
	let holdItem: HTMLElement | null = null;
	let holdPointerId: number | null = null;
	const hold = createHoldGesture({
		onlift(_x, y) {
			const item = holdItem;
			const pointerId = holdPointerId;
			holdItem = null;
			if (item && pointerId !== null && item.isConnected) grab(item, pointerId, y);
		}
	});

	function clearHold(): void {
		holdItem = null;
		holdPointerId = null;
	}

	function onPointerDown(e: PointerEvent): void {
		// Primary pointer, primary button only: a right/middle mouse press must
		// neither grab a handle nor arm the row-body engagement.
		if (!opts.enabled || live !== null || !e.isPrimary || e.button !== 0) return;
		const target = e.target as Element | null;
		const handle = target?.closest('[data-drag-handle]');
		if (handle && node.contains(handle)) {
			const item = handle.closest<HTMLElement>('[data-drag-item]');
			if (!item) return;
			// No focus flash / mouse-compat events on the handle — it has no tap
			// semantics of its own.
			e.preventDefault();
			grab(item, e.pointerId, e.clientY);
			return;
		}
		if (!opts.liftOnHold) return;
		const item = target?.closest<HTMLElement>('[data-drag-item]');
		if (!item || !node.contains(item)) return;
		// Row-body press: do NOT preventDefault (a quick tap/click must stay a
		// click) and do not own the pointer yet — `touch-action: pan-y` keeps
		// touch scrolling native. The hold machine arbitrates by pointer type:
		// touch — travel = scroll, stillness = lift; mouse/pen — travel = lift.
		holdItem = item;
		holdPointerId = e.pointerId;
		hold.down(e.clientX, e.clientY, e.pointerType);
	}

	/** Engage the drag on `item` — shared by the handle path (at pointerdown)
	 * and the long-press path (when the hold fires mid-gesture). */
	function grab(item: HTMLElement, pointerId: number, clientY: number): void {
		if (!opts.enabled || live !== null) return;
		finishSettle();
		const items = [...node.querySelectorAll<HTMLElement>(':scope > [data-drag-item]')];
		const from = items.indexOf(item);
		if (from < 0 || items.length < 2) return;

		const scroller = opts.scroller?.() ?? findScroller(node);
		const startScroll = scroller?.scrollTop ?? 0;
		// The ONLY layout reads of the whole drag: row boxes (content space) and
		// the scroller's viewport band, all snapshotted before any style write.
		const rows: RowBox[] = items.map((el) => {
			const r = el.getBoundingClientRect();
			return { top: r.top + startScroll, height: r.height };
		});
		let viewTop = 0;
		let viewBottom = Number.MAX_SAFE_INTEGER;
		if (scroller) {
			const r = scroller.getBoundingClientRect();
			viewTop = r.top;
			viewBottom = r.bottom;
		}

		// Capture keeps the stream on the container even if rows re-render
		// mid-drag (and, for a long-press lift, retargets the in-flight touch).
		node.setPointerCapture(pointerId);

		node.classList.add('drag-reorder-active');
		setDocumentDragStyle(true);
		node.style.userSelect = 'none';
		node.style.webkitUserSelect = 'none';
		node.style.setProperty('-webkit-touch-callout', 'none');
		for (const el of items) {
			el.style.willChange = 'transform';
			el.style.transition = SIBLING_TRANSITION;
		}
		item.style.transition = LIFTED_TRANSITION;
		item.classList.add('drag-lifted');

		// From here the gesture is OURS: preventDefault every (still-cancelable)
		// touchmove so WebKit never starts a native scroll post-lift.
		node.addEventListener('touchmove', blockTouch, { passive: false });

		const observer = new MutationObserver(() => cancelDrag());
		observer.observe(node, { childList: true });

		live = {
			pointerId,
			items,
			rows,
			from,
			to: from,
			startY: clientY,
			startScroll,
			lastY: clientY,
			dy: 0,
			applied: items.map(() => 0),
			scroller,
			viewTop,
			viewBottom,
			raf: requestAnimationFrame(tick),
			observer
		};
	}

	/** Per-frame: auto-scroll, then fold finger + scroll into transforms. */
	function tick(): void {
		if (!live) return;
		const d = live;
		if (d.scroller) {
			const v = edgeScrollVelocity(d.lastY, d.viewTop, d.viewBottom);
			if (v !== 0) d.scroller.scrollTop += v; // browser clamps to the range
		}
		const scrollDelta = (d.scroller?.scrollTop ?? 0) - d.startScroll;
		const dy = clampDy(d.rows, d.from, d.lastY - d.startY + scrollDelta);
		if (dy !== d.dy) {
			d.dy = dy;
			const lifted = d.items[d.from];
			if (lifted) lifted.style.transform = `translateY(${dy}px)${LIFT_TRANSFORM}`;
		}
		const to = targetIndexFor(d.rows, d.from, dy);
		if (to !== d.to) {
			d.to = to;
			const liftedH = d.rows[d.from]?.height ?? 0;
			d.items.forEach((el, i) => {
				if (i === d.from) return;
				const shift = siblingShift(i, d.from, to);
				if (shift === d.applied[i]) return;
				d.applied[i] = shift;
				el.style.transform = shift === 0 ? '' : `translateY(${shift * liftedH}px)`;
			});
		}
		d.raf = requestAnimationFrame(tick);
	}

	function onPointerMove(e: PointerEvent): void {
		if (live) {
			if (e.pointerId === live.pointerId) live.lastY = e.clientY; // the rAF loop consumes it
			return;
		}
		if (e.pointerId === holdPointerId) hold.move(e.clientX, e.clientY);
	}

	function onPointerUp(e: PointerEvent): void {
		if (e.pointerId === holdPointerId) {
			hold.up(); // pre-lift: a tap (click proceeds); post-lift: arms click suppression
			clearHold();
		}
		if (!live || e.pointerId !== live.pointerId) return;
		finishDrag(true);
	}

	function onPointerCancel(e: PointerEvent): void {
		if (e.pointerId === holdPointerId) {
			hold.cancel(); // the native pan claimed the touch — no lift, no suppression
			clearHold();
		}
		if (!live || e.pointerId !== live.pointerId) return;
		finishDrag(false);
	}

	/** A gesture that lifted must not also tap: swallow its click before the
	 * row's own handler (navigation) can see it. */
	function onClickCapture(e: MouseEvent): void {
		if (!hold.consumeClickSuppression()) return;
		e.preventDefault();
		e.stopPropagation();
	}

	/** No callout / context UI anywhere in the rows — long-press means drag. */
	function onContextMenu(e: Event): void {
		e.preventDefault();
	}

	/** No native HTML5 drag may ever start inside the rows (a mouse drag over
	 * stray selectable/draggable content would paint the OS drag ghost). */
	function onDragStart(e: Event): void {
		e.preventDefault();
	}

	function cancelDrag(): void {
		if (live) finishDrag(false);
	}

	function finishDrag(commit: boolean): void {
		const d = live;
		if (!d) return;
		live = null;
		cancelAnimationFrame(d.raf);
		d.observer.disconnect();
		node.removeEventListener('touchmove', blockTouch);
		try {
			node.releasePointerCapture(d.pointerId);
		} catch {
			/* pointer already gone */
		}
		node.classList.remove('drag-reorder-active');
		setDocumentDragStyle(false);
		node.style.userSelect = '';
		node.style.webkitUserSelect = '';
		node.style.removeProperty('-webkit-touch-callout');

		const lifted = d.items[d.from];
		if (commit && d.to !== d.from) {
			// The rows already SIT in the final arrangement (via transforms). Clear
			// the transforms with transitions suppressed and re-render to the new
			// order inside the same task — one paint, no flash.
			for (const el of d.items) {
				el.style.transition = 'none';
				el.style.transform = '';
				el.style.willChange = '';
			}
			lifted?.classList.remove('drag-lifted');
			try {
				flushSync(() => opts.onreorder(d.from, d.to));
			} finally {
				void node.offsetHeight; // commit `transition: none` before restoring
				for (const el of d.items) el.style.transition = '';
			}
			return;
		}

		// No-op drop / cancel: glide everything home, then strip the inline styles.
		if (lifted) lifted.style.transition = SIBLING_TRANSITION;
		for (const el of d.items) el.style.transform = '';
		settling = d.items;
		settleTimer = setTimeout(finishSettle, SETTLE_MS);
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerUp);
	node.addEventListener('pointercancel', onPointerCancel);
	node.addEventListener('click', onClickCapture, true);
	node.addEventListener('contextmenu', onContextMenu);
	node.addEventListener('dragstart', onDragStart);

	return {
		update(next: DragReorderOptions) {
			opts = next;
			if (!next.enabled) {
				cancelDrag();
				hold.cancel();
				clearHold();
			}
		},
		destroy() {
			cancelDrag();
			finishSettle();
			hold.destroy();
			clearHold();
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', onPointerCancel);
			node.removeEventListener('click', onClickCapture, true);
			node.removeEventListener('contextmenu', onContextMenu);
			node.removeEventListener('dragstart', onDragStart);
		}
	};
}
