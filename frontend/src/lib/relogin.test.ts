import { describe, expect, it } from 'vitest';

import { RELOGIN_PARAM, isReloginLoad, reloginUrl } from './relogin';

describe('reloginUrl', () => {
	it('marks the URL so the service worker lets the navigation reach the network', () => {
		expect(reloginUrl('https://tasks.viktorbarzin.me/')).toBe(
			`https://tasks.viktorbarzin.me/?${RELOGIN_PARAM}=1`
		);
	});

	it('keeps the current screen so login returns where the user was', () => {
		expect(reloginUrl('https://tasks.viktorbarzin.me/list/l-a')).toBe(
			`https://tasks.viktorbarzin.me/list/l-a?${RELOGIN_PARAM}=1`
		);
	});

	it('preserves existing query params', () => {
		expect(reloginUrl('https://tasks.viktorbarzin.me/view/today?filter=flagged')).toBe(
			`https://tasks.viktorbarzin.me/view/today?filter=flagged&${RELOGIN_PARAM}=1`
		);
	});

	it('is idempotent — a second tap does not stack markers', () => {
		const once = reloginUrl('https://tasks.viktorbarzin.me/');
		expect(reloginUrl(once)).toBe(once);
	});

	it('drops a hash — the SSO round trip never carries it back', () => {
		expect(reloginUrl('https://tasks.viktorbarzin.me/list/l-a#task-3')).toBe(
			`https://tasks.viktorbarzin.me/list/l-a?${RELOGIN_PARAM}=1`
		);
	});
});

describe('isReloginLoad', () => {
	it('recognises a document served by a re-login navigation', () => {
		expect(isReloginLoad(`?${RELOGIN_PARAM}=1`)).toBe(true);
		expect(isReloginLoad(`?filter=flagged&${RELOGIN_PARAM}=1`)).toBe(true);
	});

	it('is false for an ordinary load — the loop guard must not latch', () => {
		expect(isReloginLoad('')).toBe(false);
		expect(isReloginLoad('?filter=flagged')).toBe(false);
	});
});
