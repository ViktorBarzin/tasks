/// <reference lib="webworker" />
/**
 * Tasks service worker (Workbox via `@vite-pwa/sveltekit` injectManifest).
 *
 * THE founding requirement (ADR-0001, contract-delta §H): the installed PWA
 * must cold-start OFFLINE on a never-visited deep link (`/list/<id>`). So we
 * precache the app shell + every content-hashed build asset and serve the
 * shell for any in-scope navigation. The app then renders entirely from its
 * IndexedDB Replica — there is deliberately NO runtime `/api` cache (the client
 * reads the Replica, never cached HTTP responses, and its own durable Op Queue
 * handles offline writes), so nothing here can serve stale task data.
 *
 * Chosen over the generated-SW `navigateFallback` (which did not serve the
 * shell for navigations in this workbox build); this hand-written appShell
 * handler is the tripit pattern (`tripit/frontend/src/service-worker.ts`).
 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

import { RELOGIN_PARAM } from './lib/relogin';

declare let self: ServiceWorkerGlobalScope & {
	__WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const ASSET_CACHE = 'tasks-assets-v1';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

/**
 * SPA navigation fallback: serve the precached app shell (index.html) for any
 * client-side route so a never-visited deep link boots offline. Precache-key
 * agnostic — try the precached shell, then the runtime cache, then the network.
 */
async function appShell(): Promise<Response> {
	const precached = (await matchPrecache('/index.html')) ?? (await matchPrecache('index.html'));
	if (precached) return precached;
	const cached = await caches.match('/index.html', { ignoreSearch: true });
	if (cached) return cached;
	return fetch('/index.html');
}

/**
 * Navigations: the app shell, except for the §I re-login.
 *
 * A marked navigation MUST reach the network — the forward-auth bounce to the
 * SSO login is the only way back in once the session lapses, and a shell served
 * from the precache here is a dead end (the banner just comes back). Offline it
 * still falls back to the shell, so tapping "sign in" with no signal lands on
 * the app rather than the browser's error page.
 */
async function navigate(options: { request: Request; url: URL }): Promise<Response> {
	if (options.url.searchParams.has(RELOGIN_PARAM)) {
		try {
			return await fetch(options.request);
		} catch {
			return appShell();
		}
	}
	return appShell();
}

// `/api`, health and metrics are never navigations the shell should answer.
registerRoute(
	new NavigationRoute(navigate, {
		denylist: [/^\/api\//, /^\/healthz$/, /^\/metrics$/]
	})
);

self.skipWaiting();
clientsClaim();

// Content-hashed build assets under /_app (immutable) — plus SvelteKit's
// generated version.json, which isn't in the precache manifest. Cache-first so
// the SPA boots offline even on a cold navigation; a new deploy changes the
// hash, so a stale entry is never served.
registerRoute(
	({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/_app/'),
	new CacheFirst({ cacheName: ASSET_CACHE }),
	'GET'
);
