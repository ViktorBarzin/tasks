/**
 * Svelte action: touch-first drag-to-reorder for a column of rows (iOS
 * Reminders Edit mode). Pointer Events only — no HTML5 drag API.
 *
 * Contract with the markup:
 *  - the action sits on the rows' CONTAINER; direct children carrying
 *    `data-drag-item` are the reorderable rows, in visual order;
 *  - the grab affordance inside a row carries `data-drag-handle` and MUST have
 *    `touch-action: none` in CSS (it has to hold at gesture start — inline
 *    writes from pointerdown are too late for the current touch);
 *  - while a drag is live the container gets `.drag-reorder-active` and the
 *    lifted row `.drag-lifted` (lift styling — shadow/z-index — lives in CSS;
 *    the action drives transforms/transitions inline).
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

	function onPointerDown(e: PointerEvent): void {
		if (!opts.enabled || live !== null || !e.isPrimary) return;
		const handle = (e.target as Element | null)?.closest('[data-drag-handle]');
		if (!handle || !node.contains(handle)) return;
		const item = handle.closest<HTMLElement>('[data-drag-item]');
		if (!item) return;
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

		// No focus flash / mouse-compat events; capture keeps the stream on the
		// container even if rows re-render mid-drag.
		e.preventDefault();
		node.setPointerCapture(e.pointerId);

		node.classList.add('drag-reorder-active');
		node.style.userSelect = 'none';
		node.style.webkitUserSelect = 'none';
		node.style.setProperty('-webkit-touch-callout', 'none');
		for (const el of items) {
			el.style.willChange = 'transform';
			el.style.transition = SIBLING_TRANSITION;
		}
		item.style.transition = LIFTED_TRANSITION;
		item.classList.add('drag-lifted');

		node.addEventListener('touchmove', blockTouch, { passive: false });

		const observer = new MutationObserver(() => cancelDrag());
		observer.observe(node, { childList: true });

		live = {
			pointerId: e.pointerId,
			items,
			rows,
			from,
			to: from,
			startY: e.clientY,
			startScroll,
			lastY: e.clientY,
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
		if (!live || e.pointerId !== live.pointerId) return;
		live.lastY = e.clientY; // the rAF loop consumes it — nothing else here
	}

	function onPointerUp(e: PointerEvent): void {
		if (!live || e.pointerId !== live.pointerId) return;
		finishDrag(true);
	}

	function onPointerCancel(e: PointerEvent): void {
		if (!live || e.pointerId !== live.pointerId) return;
		finishDrag(false);
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

	return {
		update(next: DragReorderOptions) {
			opts = next;
			if (!next.enabled) cancelDrag();
		},
		destroy() {
			cancelDrag();
			finishSettle();
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', onPointerCancel);
		}
	};
}
