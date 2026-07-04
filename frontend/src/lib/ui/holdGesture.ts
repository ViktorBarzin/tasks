/**
 * Press-to-lift engagement — the pure state machine behind dragging a row
 * WITHOUT a drag handle. Framework-free and DOM-free so it unit-tests in
 * isolation; `dragReorder.ts` feeds it pointer events.
 *
 * Engagement is pointerType-aware (`down` receives the pointer type):
 *
 *  - TOUCH (and any unknown type — conservative default): native Reminders
 *    long-press.
 *      idle ──down──▶ pending ──HOLD_MS still──▶ lifted
 *      pending ──move >SLOP_PX──▶ idle   (the finger is scrolling)
 *      pending ──up──▶ idle              (a tap — click proceeds)
 *  - MOUSE / PEN: classic desktop drag-and-drop — NO hold timer.
 *      idle ──down──▶ pending ──move >DRAG_PX──▶ lifted   (immediately)
 *      pending ──up──▶ idle    (a click, however long the press was held)
 *  - any ──cancel──▶ idle               (pointercancel: the browser took it)
 *
 * Click suppression (identical in both modes): a gesture that LIFTED must not
 * also navigate. The lift arms a one-shot flag; the caller consumes it from a
 * capture-phase click listener. A fresh `down` re-arms from scratch (iOS often
 * swallows the click after a long press, so a stale flag must never leak onto
 * the next tap), and `cancel` clears it (no click follows a pointercancel).
 */

export const HOLD_MS = 350;
export const SLOP_PX = 8;
/** Mouse/pen travel beyond which the pressed pointer lifts (no hold), px. */
export const DRAG_PX = 5;

export type HoldState = 'idle' | 'pending' | 'lifted';

export interface HoldGestureOptions {
	/** Press-and-hold duration before the lift (touch path), ms. */
	holdMs?: number;
	/** Finger travel beyond which the press is a scroll (touch path), px (euclidean, cancels when exceeded). */
	slopPx?: number;
	/** Pressed travel beyond which a mouse/pen press lifts, px (euclidean, lifts when exceeded). */
	dragPx?: number;
	/** The gesture engaged — start the drag at the latest known pointer position. */
	onlift: (x: number, y: number) => void;
}

export interface HoldGesture {
	/** `pointerType` as on PointerEvent; 'mouse'/'pen' take the desktop path, everything else holds. */
	down(x: number, y: number, pointerType?: string): void;
	move(x: number, y: number): void;
	up(): void;
	cancel(): void;
	/** True exactly once after a lifted gesture — the caller swallows that click. */
	consumeClickSuppression(): boolean;
	state(): HoldState;
	destroy(): void;
}

export function createHoldGesture(options: HoldGestureOptions): HoldGesture {
	const holdMs = options.holdMs ?? HOLD_MS;
	const slopPx = options.slopPx ?? SLOP_PX;
	const dragPx = options.dragPx ?? DRAG_PX;

	let state: HoldState = 'idle';
	/** How the CURRENT press engages: 'hold' (touch) or 'drag' (mouse/pen). */
	let engage: 'hold' | 'drag' = 'hold';
	let suppressClick = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastY = 0;

	function clearTimer(): void {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	function fire(): void {
		clearTimer();
		state = 'lifted';
		suppressClick = true;
		options.onlift(lastX, lastY);
	}

	return {
		down(x: number, y: number, pointerType?: string): void {
			clearTimer();
			state = 'pending';
			engage = pointerType === 'mouse' || pointerType === 'pen' ? 'drag' : 'hold';
			suppressClick = false;
			startX = lastX = x;
			startY = lastY = y;
			// Desktop presses have no hold timer — only travel can lift them.
			if (engage === 'hold') timer = setTimeout(fire, holdMs);
		},
		move(x: number, y: number): void {
			if (state !== 'pending') return;
			lastX = x;
			lastY = y;
			const travel = Math.hypot(x - startX, y - startY);
			if (engage === 'drag') {
				if (travel > dragPx) fire();
			} else if (travel > slopPx) {
				clearTimer();
				state = 'idle';
			}
		},
		up(): void {
			clearTimer();
			state = 'idle';
			// suppressClick survives: a lifted gesture's click is still in flight.
		},
		cancel(): void {
			clearTimer();
			state = 'idle';
			suppressClick = false;
		},
		consumeClickSuppression(): boolean {
			const r = suppressClick;
			suppressClick = false;
			return r;
		},
		state(): HoldState {
			return state;
		},
		destroy(): void {
			clearTimer();
			state = 'idle';
			suppressClick = false;
		}
	};
}
