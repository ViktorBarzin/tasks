import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHoldGesture, HOLD_MS, SLOP_PX } from './holdGesture';

describe('createHoldGesture', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function make(overrides: { holdMs?: number; slopPx?: number } = {}) {
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
});
