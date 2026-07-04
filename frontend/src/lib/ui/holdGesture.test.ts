import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHoldGesture, DRAG_PX, HOLD_MS, SLOP_PX } from './holdGesture';

describe('createHoldGesture', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function make(overrides: { holdMs?: number; slopPx?: number; dragPx?: number } = {}) {
		const onlift = vi.fn();
		const g = createHoldGesture({ onlift, ...overrides });
		return { g, onlift };
	}

	it('engages: a still press lifts exactly at the hold threshold', () => {
		const { g, onlift } = make();
		g.down(100, 200);
		vi.advanceTimersByTime(HOLD_MS - 1);
		expect(onlift).not.toHaveBeenCalled();
		expect(g.state()).toBe('pending');
		vi.advanceTimersByTime(1);
		expect(onlift).toHaveBeenCalledTimes(1);
		expect(g.state()).toBe('lifted');
	});

	it('lifts at the latest pre-lift finger position (sub-slop drift)', () => {
		const { g, onlift } = make();
		g.down(100, 200);
		g.move(103, 204); // 5px — within slop
		vi.advanceTimersByTime(HOLD_MS);
		expect(onlift).toHaveBeenCalledWith(103, 204);
	});

	it('cancels on move past the slop (a scroll), and never lifts', () => {
		const { g, onlift } = make();
		g.down(100, 200);
		g.move(100, 200 + SLOP_PX + 1);
		expect(g.state()).toBe('idle');
		vi.advanceTimersByTime(HOLD_MS * 2);
		expect(onlift).not.toHaveBeenCalled();
		expect(g.consumeClickSuppression()).toBe(false);
	});

	it('movement exactly at the slop does NOT cancel (threshold is >slop)', () => {
		const { g, onlift } = make();
		g.down(100, 200);
		g.move(100 + SLOP_PX, 200);
		expect(g.state()).toBe('pending');
		vi.advanceTimersByTime(HOLD_MS);
		expect(onlift).toHaveBeenCalledTimes(1);
	});

	it('slop is euclidean: diagonal drift adds up', () => {
		const { g, onlift } = make();
		g.down(0, 0);
		g.move(7, 7); // ~9.9px > 8
		expect(g.state()).toBe('idle');
		vi.advanceTimersByTime(HOLD_MS);
		expect(onlift).not.toHaveBeenCalled();
	});

	it('cancels on early up: a quick tap never lifts and is not suppressed (tap navigates)', () => {
		const { g, onlift } = make();
		g.down(100, 200);
		vi.advanceTimersByTime(HOLD_MS - 100);
		g.up();
		expect(g.state()).toBe('idle');
		vi.advanceTimersByTime(HOLD_MS * 2); // the dead timer must not fire late
		expect(onlift).not.toHaveBeenCalled();
		expect(g.consumeClickSuppression()).toBe(false);
	});

	it('suppresses the post-drag tap exactly once', () => {
		const { g } = make();
		g.down(100, 200);
		vi.advanceTimersByTime(HOLD_MS);
		g.up();
		expect(g.consumeClickSuppression()).toBe(true);
		expect(g.consumeClickSuppression()).toBe(false);
	});

	it('a fresh press resets stale suppression (next tap navigates)', () => {
		const { g } = make();
		g.down(100, 200);
		vi.advanceTimersByTime(HOLD_MS);
		g.up(); // lifted gesture ended; its click may never arrive (iOS swallows it)
		g.down(100, 200); // new gesture before anything consumed the flag
		vi.advanceTimersByTime(10);
		g.up(); // quick tap
		expect(g.consumeClickSuppression()).toBe(false);
	});

	it('pointercancel clears everything — no lift, no suppression', () => {
		const { g, onlift } = make();
		g.down(100, 200);
		vi.advanceTimersByTime(HOLD_MS); // lifted
		g.cancel();
		expect(g.state()).toBe('idle');
		expect(g.consumeClickSuppression()).toBe(false);
		g.down(100, 200);
		g.cancel(); // cancel while still pending kills the timer too
		vi.advanceTimersByTime(HOLD_MS * 2);
		expect(onlift).toHaveBeenCalledTimes(1);
	});

	it('post-lift movement neither cancels nor re-fires (the drag engine owns it)', () => {
		const { g, onlift } = make();
		g.down(100, 200);
		vi.advanceTimersByTime(HOLD_MS);
		g.move(100, 400);
		expect(g.state()).toBe('lifted');
		vi.advanceTimersByTime(HOLD_MS * 2);
		expect(onlift).toHaveBeenCalledTimes(1);
	});

	it('up/move while idle are no-ops', () => {
		const { g, onlift } = make();
		g.up();
		g.move(5, 5);
		expect(g.state()).toBe('idle');
		vi.advanceTimersByTime(HOLD_MS * 2);
		expect(onlift).not.toHaveBeenCalled();
	});

	it('honors custom holdMs and slopPx', () => {
		const { g, onlift } = make({ holdMs: 100, slopPx: 20 });
		g.down(0, 0);
		g.move(0, 15); // within the wider slop
		vi.advanceTimersByTime(99);
		expect(onlift).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onlift).toHaveBeenCalledTimes(1);
	});

	it('destroy kills a pending timer', () => {
		const { g, onlift } = make();
		g.down(0, 0);
		g.destroy();
		vi.advanceTimersByTime(HOLD_MS * 2);
		expect(onlift).not.toHaveBeenCalled();
		expect(g.state()).toBe('idle');
	});

	// --- pointerType matrix: mouse/pen engage desktop-style (travel, no hold);
	// touch and unknown pointer types keep the hold path bit-for-bit. ---

	describe.each(['mouse', 'pen'] as const)("desktop engagement — pointerType '%s'", (pt) => {
		it('lifts IMMEDIATELY when pressed travel crosses the drag threshold — no hold timer', () => {
			const { g, onlift } = make();
			g.down(100, 200, pt);
			g.move(100, 200 + DRAG_PX + 1); // no timer advance at all
			expect(onlift).toHaveBeenCalledTimes(1);
			expect(onlift).toHaveBeenCalledWith(100, 200 + DRAG_PX + 1);
			expect(g.state()).toBe('lifted');
		});

		it('travel exactly at the threshold does NOT lift (threshold is >dragPx)', () => {
			const { g, onlift } = make();
			g.down(100, 200, pt);
			g.move(100 + DRAG_PX, 200);
			expect(g.state()).toBe('pending');
			expect(onlift).not.toHaveBeenCalled();
		});

		it('the drag threshold is euclidean: diagonal travel adds up', () => {
			const { g, onlift } = make();
			g.down(0, 0, pt);
			g.move(4, 4); // ~5.66px > 5
			expect(onlift).toHaveBeenCalledTimes(1);
		});

		it('a stationary press NEVER lifts, however long the button is held (no hold timer armed)', () => {
			const { g, onlift } = make();
			g.down(100, 200, pt);
			vi.advanceTimersByTime(HOLD_MS * 10);
			expect(onlift).not.toHaveBeenCalled();
			expect(g.state()).toBe('pending');
			g.up(); // a long stationary press is still a click on desktop
			expect(g.consumeClickSuppression()).toBe(false);
		});

		it('sub-threshold press + release stays a click (no lift, no suppression)', () => {
			const { g, onlift } = make();
			g.down(100, 200, pt);
			g.move(103, 200); // 3px < 5
			g.up();
			expect(g.state()).toBe('idle');
			expect(onlift).not.toHaveBeenCalled();
			expect(g.consumeClickSuppression()).toBe(false);
			vi.advanceTimersByTime(HOLD_MS * 2); // nothing may fire late
			expect(onlift).not.toHaveBeenCalled();
		});

		it('the click after a drag is suppressed exactly once', () => {
			const { g } = make();
			g.down(100, 200, pt);
			g.move(120, 200); // lift
			g.up(); // drop
			expect(g.consumeClickSuppression()).toBe(true);
			expect(g.consumeClickSuppression()).toBe(false);
		});

		it('post-lift movement neither cancels nor re-fires (the drag engine owns it)', () => {
			const { g, onlift } = make();
			g.down(0, 0, pt);
			g.move(20, 0);
			g.move(0, 300);
			expect(onlift).toHaveBeenCalledTimes(1);
			expect(g.state()).toBe('lifted');
		});

		it('cancel while pending kills the press (no later lift, no suppression)', () => {
			const { g, onlift } = make();
			g.down(0, 0, pt);
			g.cancel();
			g.move(0, 50);
			expect(g.state()).toBe('idle');
			expect(onlift).not.toHaveBeenCalled();
			expect(g.consumeClickSuppression()).toBe(false);
		});

		it('honors a custom dragPx', () => {
			const { g, onlift } = make({ dragPx: 12 });
			g.down(0, 0, pt);
			g.move(0, 10); // within the wider threshold
			expect(onlift).not.toHaveBeenCalled();
			g.move(0, 13);
			expect(onlift).toHaveBeenCalledTimes(1);
		});
	});

	describe('touch semantics are pointerType-gated, not just the default', () => {
		it("an explicit 'touch' holds to lift: travel past the MOUSE threshold neither lifts nor cancels", () => {
			const { g, onlift } = make();
			g.down(100, 200, 'touch');
			g.move(100, 206); // 6px: > DRAG_PX but ≤ SLOP_PX — must stay pending
			expect(g.state()).toBe('pending');
			expect(onlift).not.toHaveBeenCalled();
			vi.advanceTimersByTime(HOLD_MS);
			expect(onlift).toHaveBeenCalledTimes(1); // the hold, not the travel, lifted it
		});

		it("an unknown pointerType ('' is spec-legal) gets the conservative hold path", () => {
			const { g, onlift } = make();
			g.down(100, 200, '');
			g.move(100, 207); // 7px: no desktop lift…
			expect(g.state()).toBe('pending');
			expect(onlift).not.toHaveBeenCalled();
			g.move(100, 209); // …and past the slop it cancels like touch (a scroll)
			expect(g.state()).toBe('idle');
			vi.advanceTimersByTime(HOLD_MS * 2);
			expect(onlift).not.toHaveBeenCalled();
		});
	});
});
