/**
 * Svelte action: pull-to-refresh on an inner scroller. iOS standalone PWAs
 * have no native PTR, so this recreates it: pulling down while scrolled to
 * the top drags the content (with resistance) and, past the threshold,
 * runs the async refresh with a minimum spinner dwell.
 *
 * The host element gets `--ptr-offset` (px) and the classes `ptr-pulling` /
 * `ptr-refreshing` / `ptr-armed`; the screen's spinner styles hang off those.
 */
export interface PullToRefreshOptions {
	onrefresh: () => Promise<unknown>;
}

const THRESHOLD_PX = 70;
const MIN_SPIN_MS = 500;

export function pullToRefresh(node: HTMLElement, options: PullToRefreshOptions) {
	let opts = options;
	let startY = 0;
	let pulling = false;
	let refreshing = false;

	function setOffset(px: number): void {
		node.style.setProperty('--ptr-offset', `${px}px`);
		node.classList.toggle('ptr-armed', px >= THRESHOLD_PX);
	}

	function onStart(e: TouchEvent): void {
		if (refreshing || node.scrollTop > 0 || e.touches.length !== 1) return;
		startY = e.touches[0]?.clientY ?? 0;
		pulling = true;
	}

	function onMove(e: TouchEvent): void {
		if (!pulling || refreshing) return;
		const dy = (e.touches[0]?.clientY ?? 0) - startY;
		if (dy <= 0 || node.scrollTop > 0) {
			node.classList.remove('ptr-pulling');
			setOffset(0);
			return;
		}
		// Only hijack the gesture while genuinely at the top and pulling down.
		if (e.cancelable) e.preventDefault();
		node.classList.add('ptr-pulling');
		setOffset(Math.min(dy * 0.45, THRESHOLD_PX * 1.6));
	}

	async function onEnd(): Promise<void> {
		if (!pulling) return;
		pulling = false;
		const armed = node.classList.contains('ptr-armed');
		node.classList.remove('ptr-pulling');
		if (!armed) {
			setOffset(0);
			return;
		}
		refreshing = true;
		node.classList.add('ptr-refreshing');
		setOffset(THRESHOLD_PX * 0.8);
		const started = Date.now();
		try {
			await opts.onrefresh();
		} finally {
			const dwell = Math.max(0, MIN_SPIN_MS - (Date.now() - started));
			setTimeout(() => {
				node.classList.remove('ptr-refreshing', 'ptr-armed');
				setOffset(0);
				refreshing = false;
			}, dwell);
		}
	}

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchmove', onMove, { passive: false });
	node.addEventListener('touchend', () => void onEnd(), { passive: true });
	node.addEventListener('touchcancel', () => void onEnd(), { passive: true });

	return {
		update(next: PullToRefreshOptions) {
			opts = next;
		}
	};
}
