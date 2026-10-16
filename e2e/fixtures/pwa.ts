import { test as base, expect, type Page } from "@playwright/test";

import { SVELTE_BUILD } from "../global-setup";
import { type PwaServer, startPwaServer } from "./pwa-server";

/** A per-test stub origin in front of the built server (see pwa-server.ts). */
export const test = base.extend<{ pwa: PwaServer }>({
	pwa: async ({ baseURL }, use) => {
		if (!baseURL) throw new Error("baseURL (the built server) is required");
		const server = await startPwaServer({
			upstream: baseURL,
			svelteBuild: SVELTE_BUILD,
		});
		await use(server);
		await server.close();
	},
});

export { expect };

/**
 * Resolves once the service worker controls the page AND the shell is in the
 * precache; before that a navigation can reach the network by accident.
 */
export async function installedPwa(
	page: Page,
	shellPath: string,
): Promise<void> {
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);
	await page.waitForFunction(async (path) => {
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			for (const request of await cache.keys()) {
				if (new URL(request.url).pathname === path) return true;
			}
		}
		return false;
	}, shellPath);
}

/** Foreground the app the way a resumed PWA does (a sync trigger). */
export async function resume(page: Page): Promise<void> {
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}
