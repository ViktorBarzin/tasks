/**
 * §I re-login — the one navigation that must reach Traefik→Authentik.
 *
 * An installed PWA answers its own navigations from the precached app shell
 * (§H, the offline cold-start requirement), so the plain `location.assign('/')`
 * the spec called for never left the device: the shell came back from the
 * cache, the next sync cycle hit the wall again, and the "Session expired"
 * banner reappeared — a loop with no way back in.
 *
 * The marker query below is the escape hatch. `service-worker.ts` sees it and
 * goes to the network (falling back to the shell only when offline), which is
 * what lets the forward-auth proxy bounce the navigation to the SSO login.
 */
export const RELOGIN_PARAM = 'relogin';

/**
 * The current URL, marked for re-login. The path is kept so the SSO round trip
 * returns the user to the screen they were on; the hash is dropped because the
 * redirect chain never carries it back anyway.
 */
export function reloginUrl(currentHref: string): string {
	const url = new URL(currentHref);
	url.hash = '';
	url.searchParams.set(RELOGIN_PARAM, '1');
	return url.href;
}

/** True when this document was loaded by a re-login navigation. */
export function isReloginLoad(search: string): boolean {
	return new URLSearchParams(search).has(RELOGIN_PARAM);
}

/** Leave for the login page. A full navigation — the SW lets this one out. */
export function startRelogin(): void {
	window.location.assign(reloginUrl(window.location.href));
}

/**
 * Drop the marker once the app is back up, so a later reload of this URL is an
 * ordinary shell-served navigation again.
 */
export function clearReloginMarker(): void {
	const url = new URL(window.location.href);
	url.searchParams.delete(RELOGIN_PARAM);
	window.history.replaceState(window.history.state, '', url.href);
}
