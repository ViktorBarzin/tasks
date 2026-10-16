/**
 * Session expiry and re-login through a LIVE service worker: the OIDC
 * equivalent of the Svelte build's e2e-sw/relogin.spec.ts, and the acceptance
 * criteria from tasks ADR-0003 (re-login escapes the app shell) and ADR-0004
 * (sign-in in a popup), now detected by a 401 instead of an opaqueredirect.
 *
 * The service worker precaches the app shell and serves it for every in-scope
 * navigation (§H, the offline cold start). Sign-in must still reach the
 * network: it starts at /api/signin, which the worker never answers, and goes
 * through the OIDC round trip (SSO stand-in in e2e/fixtures/pwa-server.ts).
 */
import { expect, installedPwa, resume, test } from "../fixtures/pwa";

const LISTS = ["Alpha", "Bravo"];

test("a blocked popup falls back to the full-page sign-in and gets back to the same screen", async ({
	page,
	pwa,
}) => {
	await page.addInitScript(() => {
		window.open = () => null;
	});
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	await installedPwa(page, "/");
	await page.locator(".list-row", { hasText: "Bravo" }).click();
	await expect(page).toHaveURL(/\/list\/l-b$/);

	// The session lapses while the app is open: the API now answers 401.
	pwa.authenticated = false;
	await resume(page);
	const signIn = page.getByRole("button", { name: /session expired/i });
	await expect(signIn).toBeVisible();

	// With no popup, the app window itself goes to the provider's login...
	await signIn.click();
	await expect(page.locator("#sso-login")).toBeVisible();

	// ...and completing it returns a working, syncing app on the same screen.
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page).toHaveURL(`${pwa.appUrl}/list/l-b`);
	await expect(page.locator(".large-title")).toHaveText("Bravo");
	await expect(
		page.getByRole("button", { name: /session expired/i }),
	).toBeHidden();
});

test("a popup closed before finishing escalates to the full-page path on the next tap", async ({
	page,
	context,
	pwa,
}) => {
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	await installedPwa(page, "/");

	pwa.authenticated = false;
	await resume(page);
	await expect(
		page.getByRole("button", { name: /session expired/i }),
	).toBeVisible();

	// Open the popup, then abandon it: a popup that never yields a session for
	// THIS app (the iOS case in miniature).
	const [popup] = await Promise.all([
		context.waitForEvent("page"),
		page.getByRole("button", { name: /session expired/i }).click(),
	]);
	await expect(popup.locator("#sso-login")).toBeVisible();
	await popup.close();

	// The banner now offers the path that always works, and that tap delivers.
	const retry = page.getByRole("button", { name: /sign in here/i });
	await expect(retry).toBeVisible();
	await retry.click();
	await expect(page.locator("#sso-login")).toBeVisible();
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	await expect(
		page.getByRole("button", { name: /session expired/i }),
	).toBeHidden();
});

test("the sign-in popup restores the session without reloading the app", async ({
	page,
	context,
	pwa,
}) => {
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	await installedPwa(page, "/");

	// Mark the live document: if the app reloads, the mark is gone.
	await page.evaluate(() => {
		(window as unknown as { __kept: boolean }).__kept = true;
	});

	pwa.authenticated = false;
	await resume(page);
	const signIn = page.getByRole("button", { name: /session expired/i });
	await expect(signIn).toBeVisible();

	const [popup] = await Promise.all([
		context.waitForEvent("page"),
		signIn.click(),
	]);
	await expect(popup.locator("#sso-login")).toBeVisible();
	await popup.getByRole("button", { name: "Continue" }).click();

	// Session restored, banner gone, app never reloaded.
	await expect(
		page.getByRole("button", { name: /session expired/i }),
	).toBeHidden();
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	expect(
		await page.evaluate(
			() => (window as unknown as { __kept?: boolean }).__kept,
		),
	).toBe(true);
});

test("signing in with no signal stays in the app, not on a browser error page", async ({
	page,
	context,
	pwa,
}) => {
	// No popup, so the tap takes the full-page path: the one that would leave
	// the app for a page the service worker does not answer.
	await page.addInitScript(() => {
		window.open = () => null;
	});
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	await installedPwa(page, "/");

	pwa.authenticated = false;
	await resume(page);
	const signIn = page.getByRole("button", { name: /session expired/i });
	await expect(signIn).toBeVisible();

	await context.setOffline(true);
	await signIn.click();

	// Still the app, tasks readable, banner still up for a retry with signal.
	await page.waitForTimeout(500);
	expect(page.url()).toBe(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	await expect(signIn).toBeVisible();
});

test("a device with nothing cached and no session gets the sign-in wall, and signing in lands in the app", async ({
	page,
	pwa,
}) => {
	await page.addInitScript(() => {
		window.open = () => null;
	});
	pwa.authenticated = false;
	await page.goto(`${pwa.appUrl}/`);
	// Never signed in on this device: plain sign-in copy, not "expired".
	await expect(
		page.getByRole("heading", { name: "Sign in to Tasks" }),
	).toBeVisible();
	await expect(page.getByText(/session expired|has run out/i)).toHaveCount(0);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.locator("#sso-login")).toBeVisible();
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.locator(".list-name")).toHaveText(LISTS);
});

test("a device that signed in before but has no Replica gets the expired wall", async ({
	page,
	pwa,
}) => {
	// Signed in, but stopped at the Nextcloud step: the username is cached,
	// no Replica is.
	pwa.connected = false;
	await page.goto(`${pwa.appUrl}/`);
	await expect(
		page.getByRole("heading", { name: "Connect Nextcloud" }),
	).toBeVisible();

	// The session lapses before the next visit.
	pwa.authenticated = false;
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Session expired" }),
	).toBeVisible();
	await expect(
		page.getByText("Your sign-in has run out.", { exact: false }),
	).toBeVisible();
});

test("a device with nothing cached signs in through the popup and lands in the app", async ({
	page,
	context,
	pwa,
}) => {
	pwa.authenticated = false;
	await page.goto(`${pwa.appUrl}/`);
	// Never signed in on this device: plain sign-in copy, not "expired".
	await expect(
		page.getByRole("heading", { name: "Sign in to Tasks" }),
	).toBeVisible();
	await expect(page.getByText(/session expired|has run out/i)).toHaveCount(0);
	const [popup] = await Promise.all([
		context.waitForEvent("page"),
		page.getByRole("button", { name: "Sign in" }).click(),
	]);
	await popup.getByRole("button", { name: "Continue" }).click();
	// The wall had no app behind it: signing in runs the launch decision again.
	await expect(page.locator(".list-name")).toHaveText(LISTS);
});

test("the shell still cold-starts offline on a never-visited deep link (§H)", async ({
	page,
	context,
	pwa,
}) => {
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(LISTS);
	await installedPwa(page, "/");

	// Kill the network entirely: the deep link must still boot from the worker,
	// and render that List from the Replica.
	await context.setOffline(true);
	await page.goto(`${pwa.appUrl}/list/l-a`);
	await expect(page.locator(".app-shell")).toBeVisible();
	await expect(page.locator(".large-title")).toHaveText("Alpha");
	await expect(page.locator(".pill.offline")).toBeVisible();
});
