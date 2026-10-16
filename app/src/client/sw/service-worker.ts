/**
 * Tasks service worker (Workbox, built by vite-plugin-pwa's injectManifest).
 *
 * It replaces the Svelte build's worker on the same origin and at the same
 * URL (`/service-worker.js`): the installed PWAs' update check fetches that
 * URL, so a different one would leave them on the old worker for good.
 *
 * THE founding requirement (tasks ADR-0001, contract-delta §H): the installed
 * PWA cold-starts OFFLINE on a never-visited deep link (`/list/<id>`). So the
 * app shell and every content-hashed build asset are precached, and the shell
 * answers every in-scope navigation. The app then renders entirely from its
 * IndexedDB Replica. There is deliberately no runtime `/api` cache.
 *
 * The shell is the server's response to `/`: the server renders every page as
 * the same client-only shell (TSS_SHELL in vite.config.ts), so one precached
 * copy boots any route. Its precache revision changes with every build.
 *
 * Not answered here, so they always reach the network:
 * - `/api/**`: the API, the OIDC sign-in and callback (`/api/signin`,
 *   `/api/auth/**`) and the SSE stream;
 * - `/_serverFn/**`, `/healthz`, `/metrics`;
 * - `/pending` and `/admin/**`: they render outside AppGate and load through
 *   server functions, so they need the network anyway, and hydrating the
 *   precached `/` shell on them is a React hydration mismatch.
 */
import { clientsClaim } from "workbox-core";
import {
	cleanupOutdatedCaches,
	matchPrecache,
	precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

/** The slice of ServiceWorkerGlobalScope used here (the DOM lib lacks it). */
interface ExtendableEventLike extends Event {
	waitUntil(promise: Promise<unknown>): void;
}
declare const self: {
	__WB_MANIFEST: Array<{ url: string; revision: string | null }>;
	skipWaiting(): Promise<void>;
	addEventListener(
		type: "activate",
		listener: (event: ExtendableEventLike) => void,
	): void;
};

/** Must match SHELL_URL in vite.config.ts (the precache entry it adds). */
const SHELL_URL = "/";

/** The Svelte build's runtime cache for /_app/*; nothing reads it any more. */
const LEGACY_ASSET_CACHE = "tasks-assets-v1";

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

async function appShell(): Promise<Response> {
	return (await matchPrecache(SHELL_URL)) ?? fetch(SHELL_URL);
}

registerRoute(
	new NavigationRoute(appShell, {
		denylist: [
			/^\/api\//,
			/^\/_serverFn\//,
			/^\/healthz$/,
			/^\/metrics$/,
			/^\/pending$/,
			/^\/admin(\/|$)/,
		],
	}),
);

void self.skipWaiting();
clientsClaim();

self.addEventListener("activate", (event) => {
	event.waitUntil(caches.delete(LEGACY_ASSET_CACHE));
});
