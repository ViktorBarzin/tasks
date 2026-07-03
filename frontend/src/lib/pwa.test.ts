import { afterEach, describe, expect, it, vi } from 'vitest';

import { SW_UPDATE_INTERVAL_MS, scheduleSwUpdates, type VisibilityDoc } from './pwa';

/** A fake `document` that records visibilitychange listeners and can fire them. */
function mockDoc(visibilityState: DocumentVisibilityState = 'visible') {
	const listeners = new Set<() => void>();
	return {
		visibilityState,
		addEventListener: vi.fn((_type: 'visibilitychange', cb: () => void) => listeners.add(cb)),
		removeEventListener: vi.fn((_type: 'visibilitychange', cb: () => void) => listeners.delete(cb)),
		fire: () => listeners.forEach((cb) => cb()),
		get listenerCount() {
			return listeners.size;
		}
	} satisfies VisibilityDoc & { fire: () => void; listenerCount: number };
}

afterEach(() => vi.useRealTimers());

describe('scheduleSwUpdates (§K)', () => {
	it('polls registration.update() every hour', () => {
		vi.useFakeTimers();
		const reg = { update: vi.fn() };
		scheduleSwUpdates(reg, mockDoc());

		expect(reg.update).not.toHaveBeenCalled();
		vi.advanceTimersByTime(SW_UPDATE_INTERVAL_MS);
		expect(reg.update).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(SW_UPDATE_INTERVAL_MS);
		expect(reg.update).toHaveBeenCalledTimes(2);
	});

	it('updates when the app returns to the foreground, but not while hidden', () => {
		const reg = { update: vi.fn() };
		const doc = mockDoc('visible');
		scheduleSwUpdates(reg, doc);

		doc.fire();
		expect(reg.update).toHaveBeenCalledTimes(1);

		doc.visibilityState = 'hidden';
		doc.fire();
		expect(reg.update).toHaveBeenCalledTimes(1); // still 1 — no check while hidden
	});

	it('teardown clears the timer and detaches the listener', () => {
		vi.useFakeTimers();
		const reg = { update: vi.fn() };
		const doc = mockDoc();

		const stop = scheduleSwUpdates(reg, doc);
		stop();

		vi.advanceTimersByTime(SW_UPDATE_INTERVAL_MS * 3);
		doc.fire();
		expect(reg.update).not.toHaveBeenCalled();
		expect(doc.listenerCount).toBe(0);
	});
});
