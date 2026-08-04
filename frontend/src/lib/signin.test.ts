import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SIGNIN_POLL_MS, signIn, signinFailed, signinPending } from './signin';

/** A popup stand-in: `closed` flips when the user (or the page) closes it. */
function fakePopup(): Window & { closed: boolean } {
	return { closed: false, close: vi.fn() } as unknown as Window & { closed: boolean };
}

function deps(over: Partial<Parameters<typeof signIn>[0]> = {}) {
	return {
		openPopup: vi.fn(() => fakePopup() as Window | null),
		probe: vi.fn(async () => false),
		onSignedIn: vi.fn(),
		navigate: vi.fn(),
		wait: vi.fn(async () => {}),
		...over
	};
}

beforeEach(() => {
	signinPending.set(false);
	signinFailed.set(false);
});

describe('signIn', () => {
	it('falls back to a full navigation when the browser blocks the popup', async () => {
		const d = deps({ openPopup: vi.fn(() => null) });

		expect(await signIn(d)).toBe('navigated');
		expect(d.navigate).toHaveBeenCalledOnce();
		expect(d.probe).not.toHaveBeenCalled();
	});

	it('completes when the session goes live, and closes the popup', async () => {
		const popup = fakePopup();
		let polls = 0;
		const d = deps({
			openPopup: vi.fn(() => popup as Window | null),
			probe: vi.fn(async () => ++polls >= 2)
		});

		expect(await signIn(d)).toBe('signed-in');
		expect(d.onSignedIn).toHaveBeenCalledOnce();
		expect(popup.close).toHaveBeenCalledOnce();
		expect(d.navigate).not.toHaveBeenCalled();
	});

	it('gives up when the popup is closed without a session — and never yanks the app away', async () => {
		const popup = fakePopup();
		const d = deps({
			openPopup: vi.fn(() => popup as Window | null),
			wait: vi.fn(async () => {
				popup.closed = true;
			})
		});

		expect(await signIn(d)).toBe('abandoned');
		expect(d.navigate).not.toHaveBeenCalled();
		// The banner now offers the reliable path instead of retrying the popup.
		expect(get(signinFailed)).toBe(true);
	});

	it('gives up after the deadline rather than polling forever', async () => {
		const probe = vi.fn(async () => false);

		expect(await signIn(deps({ probe }))).toBe('abandoned');
		// Bounded: a 3-minute budget at the poll interval.
		expect(probe.mock.calls.length).toBeLessThanOrEqual(180_000 / SIGNIN_POLL_MS + 1);
		expect(probe.mock.calls.length).toBeGreaterThan(1);
	});

	it('publishes a pending flag for the banner, and always clears it', async () => {
		const pendingDuringPoll: boolean[] = [];
		const d = deps({
			probe: vi.fn(async () => {
				pendingDuringPoll.push(get(signinPending));
				return true;
			})
		});

		await signIn(d);
		expect(pendingDuringPoll).toEqual([true]);
		expect(get(signinPending)).toBe(false);
	});

	it('clears a previous failure when a fresh attempt starts', async () => {
		signinFailed.set(true);
		const d = deps({ probe: vi.fn(async () => true) });

		await signIn(d);
		expect(get(signinFailed)).toBe(false);
	});
});
