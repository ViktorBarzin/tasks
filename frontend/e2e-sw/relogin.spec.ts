/**
 * §I auth-wall re-login, exercised through a LIVE service worker — the state
 * Viktor hit: "session expired and there's no way to sign in from the app".
 *
 * The SW precaches the app shell and serves it for every in-scope navigation
 * (§H, the offline cold-start requirement). The sign-in remediation is a full
 * navigation to '/', which must instead reach the network so Traefik→Authentik
 * can bounce it to the login page. Those two requirements collide, and this
 * spec is the collision: boot authenticated so the shell is precached, expire
 * the session, then assert the banner's sign-in actually lands on the SSO page
 * and that completing the login puts a syncing app back on screen.
 */
import { expect, test, type Page } from '@playwright/test';

const APP = 'http://127.0.0.1:4930';

/** Resolves once the SW controls the page AND the shell is in the precache —
 * before that, `appShell()` falls through to the network and the wall would be
 * reached by accident rather than by design. */
async function installedPwa(page: Page): Promise<void> {
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);
	await page.waitForFunction(async () => {
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			const keys = await cache.keys();
			if (keys.some((request) => new URL(request.url).pathname.endsWith('index.html')))
				return true;
		}
		return false;
	});
}

/** Foreground the app the way a resumed PWA does — the §I trigger for a cycle. */
async function resume(page: Page): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

test.beforeEach(async ({ request }) => {
	await request.get(`${APP}/__test/restore`);
});

test('an expired SSO session can be re-authenticated from the installed PWA', async ({
	page,
	request
}) => {
	await page.goto('/');
	await expect(page.locator('.list-name')).toHaveText(['Alpha', 'Bravo']);
	await installedPwa(page);

	// The SSO session lapses while the app sits on the home screen.
	await request.get(`${APP}/__test/expire`);
	await resume(page);

	const signIn = page.getByRole('button', { name: /session expired/i });
	await expect(signIn).toBeVisible();

	// The remediation must leave the app and reach the login page.
	await signIn.click();
	await expect(page.locator('#sso-login')).toBeVisible();

	// And completing the login must return a working, syncing app — not a shell
	// still showing the banner.
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.locator('.list-name')).toHaveText(['Alpha', 'Bravo']);
	await expect(page.getByRole('button', { name: /session expired/i })).toBeHidden();
});

test('signing in with no signal falls back to the app, not a browser error page', async ({
	page,
	context,
	request
}) => {
	await page.goto('/');
	await expect(page.locator('.list-name')).toHaveText(['Alpha', 'Bravo']);
	await installedPwa(page);

	await request.get(`${APP}/__test/expire`);
	await resume(page);
	const signIn = page.getByRole('button', { name: /session expired/i });
	await expect(signIn).toBeVisible();

	// Underground, no signal: the marked navigation cannot reach the network.
	await context.setOffline(true);
	await signIn.click();

	// The shell comes back with the tasks still readable — the banner stays up so
	// the user can try again once there's signal.
	await expect(page.locator('.list-name')).toHaveText(['Alpha', 'Bravo']);
});

test('the shell still cold-starts offline on a never-visited deep link (§H)', async ({
	page,
	context
}) => {
	await page.goto('/');
	await installedPwa(page);

	// Kill the network entirely: the deep link must still boot from the SW.
	await context.setOffline(true);
	await page.goto('/list/l-a');
	await expect(page.locator('.app-shell')).toBeVisible();
});
