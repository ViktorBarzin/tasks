/**
 * Svelte action: swipe-right-to-complete on a task row (Reminders gesture).
 * Horizontal-intent detection keeps vertical scrolling native (`touch-action:
 * pan-y` on the row); past the threshold the row commits on release.
 */
export interface SwipeOptions {
	/** Called when the swipe passes the commit threshold and is released. */
	oncommit: () => void;
	enabled?: boolean;
}

const COMMIT_PX = 72;
const INTENT_PX = 12;

export function swipeComplete(node: HTMLElement, options: SwipeOptions) {
	let opts = options;
	let startX = 0;
	let startY = 0;
	let dragging = false;
	let intent = false;

	function setOffset(px: number, animate: boolean): void {
		node.style.transition = animate ? 'transform 0.18s ease-out' : 'none';
		node.style.transform = px > 0 ? `translateX(${px}px)` : '';
		node.classList.toggle('swipe-armed', px >= COMMIT_PX);
	}

	function onStart(e: TouchEvent): void {
		if (opts.enabled === false || e.touches.length !== 1) return;
		const t = e.touches[0];
		if (!t) return;
		startX = t.clientX;
		startY = t.clientY;
		dragging = true;
		intent = false;
	}

	function onMove(e: TouchEvent): void {
		if (!dragging) return;
		const t = e.touches[0];
		if (!t) return;
		const dx = t.clientX - startX;
		const dy = t.clientY - startY;
		if (!intent) {
			if (Math.abs(dy) > Math.abs(dx)) {
				dragging = false; // vertical scroll wins
				return;
			}
			if (dx < INTENT_PX) return;
			intent = true;
		}
		// Resistance past the threshold.
		const eased = dx <= COMMIT_PX ? dx : COMMIT_PX + (dx - COMMIT_PX) * 0.3;
		setOffset(Math.max(0, eased), false);
	}

	function onEnd(e: TouchEvent): void {
		if (!dragging) return;
		dragging = false;
		if (!intent) return;
		const t = e.changedTouches[0];
		const dx = (t?.clientX ?? startX) - startX;
		setOffset(0, true);
		if (dx >= COMMIT_PX) opts.oncommit();
	}

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchmove', onMove, { passive: true });
	node.addEventListener('touchend', onEnd, { passive: true });
	node.addEventListener('touchcancel', onEnd, { passive: true });

	return {
		update(next: SwipeOptions) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('touchstart', onStart);
			node.removeEventListener('touchmove', onMove);
			node.removeEventListener('touchend', onEnd);
			node.removeEventListener('touchcancel', onEnd);
		}
	};
}
