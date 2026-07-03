/**
 * Long-press-to-lift hold timer — the pure state machine behind dragging a row
 * WITHOUT a drag handle (native Reminders behavior: press-and-hold anywhere on
 * the row, then drag). Framework-free and DOM-free so it unit-tests in
 * isolation; `dragReorder.ts` feeds it pointer events.
 *
 * States:  idle ──down──▶ pending ──HOLD_MS still──▶ lifted
 *          pending ──move >SLOP_PX──▶ idle   (the finger is scrolling)
 *          pending ──up──▶ idle              (a tap — click proceeds)
 *          any ──cancel──▶ idle              (pointercancel: native pan took it)
 *
 * Click suppression: a gesture that LIFTED must not also navigate. The lift
 * arms a one-shot flag; the caller consumes it from a capture-phase click
 * listener. A fresh `down` re-arms from scratch (iOS often swallows the click
 * after a long press, so a stale flag must never leak onto the next tap), and
 * `cancel` clears it (no click follows a pointercancel).
 */

export const HOLD_MS = 350;
export const SLOP_PX = 8;

export type HoldState = 'idle' | 'pending' | 'lifted';

export interface HoldGestureOptions {
	/** Press-and-hold duration before the lift, ms. */
	holdMs?: number;
	/** Finger travel beyond which the press is a scroll, px (euclidean, cancels when exceeded). */
	slopPx?: number;
	/** The hold survived — engage the drag at the latest known finger position. */
	onlift: (x: number, y: number) => void;
}

export interface HoldGesture {
	down(x: number, y: number): void;
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

	let state: HoldState = 'idle';
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
		timer = null;
		state = 'lifted';
		suppressClick = true;
		options.onlift(lastX, lastY);
	}

	return {
		down(x: number, y: number): void {
			clearTimer();
			state = 'pending';
			suppressClick = false;
			startX = lastX = x;
			startY = lastY = y;
			timer = setTimeout(fire, holdMs);
		},
		move(x: number, y: number): void {
			if (state !== 'pending') return;
			lastX = x;
			lastY = y;
			if (Math.hypot(x - startX, y - startY) > slopPx) {
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
