/**
 * The cutover (ADR-0001, Pilot / Client continuity): ops queued OFFLINE by
 * the old Svelte build must drain from the React build that replaces it on
 * the same origin. The React build inherits the Svelte build's service worker
 * registration and IndexedDB, so this is the frozen-contract test:
 *
 * 1. The Svelte PWA (../frontend/build) is installed and has synced.
 * 2. Offline, the user makes changes; the Svelte build queues them as ops.
 * 3. The server swaps to the React build. Back online, the installed PWA's
 *    update check fetches /service-worker.js, gets the React worker, which
 *    takes over and reloads the page onto the React app.
 * 4. The React app drains the Svelte build's queue: the server receives
 *    exactly the ops the Svelte build stored, byte for byte.
 *
 * The first test holds back POST /api/ops that lack X-Tasks-Client-Id (503,
 * which both builds treat as "retry later") after the swap, so the ops cannot
 * be drained by the old page while the new worker installs: what arrives was
 * sent by the React build.
 *
 * The second test is what production does: the browser has no Better Auth
 * session on the new server, so both the old page and the React build get a
 * 401 first. The queue must survive both, and drain after a popup sign-in.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext, Page } from "@playwright/test";

import { expect, installedPwa, test } from "../fixtures/pwa";
import type { PwaServer } from "../fixtures/pwa-server";
import { SVELTE_BUILD } from "../global-setup";

interface QueuedRow {
	seq: number;
	op: { op_id: string; kind: string; [key: string]: unknown };
	enqueuedAt: number;
	attempts: number;
}

/** Every row of one store, read straight from IndexedDB (name `tasks`, v2). */
async function readStore<T>(page: Page, store: string): Promise<T[]> {
	return page.evaluate(
		(name) =>
			new Promise<T[]>((resolve, reject) => {
				const open = indexedDB.open("tasks");
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const req = db.transaction(name).objectStore(name).getAll();
					req.onsuccess = () => {
						db.close();
						resolve(req.result as T[]);
					};
					req.onerror = () => reject(req.error);
				};
			}),
		store,
	);
}

/** The raw `op_queue` rows. */
const readQueue = (page: Page) => readStore<QueuedRow>(page, "op_queue");

async function databaseShape(page: Page) {
	return page.evaluate(
		() =>
			new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
				const open = indexedDB.open("tasks");
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const shape = {
						version: db.version,
						stores: [...db.objectStoreNames].sort(),
					};
					db.close();
					resolve(shape);
				};
			}),
	);
}

interface Fixtures {
	page: Page;
	context: BrowserContext;
	pwa: PwaServer;
}

/**
 * Steps 1 and 2: the Svelte PWA installed and synced, then a quick-add and a
 * list rename made offline. Returns the queued rows and the database layout.
 */
async function queueOfflineOnSvelte({ page, context, pwa }: Fixtures) {
	expect(
		existsSync(join(SVELTE_BUILD, "index.html")),
		`no Svelte build at ${SVELTE_BUILD} (e2e/global-setup.ts builds it)`,
	).toBe(true);

	// 1. The old app, installed and synced.
	pwa.mode = "svelte";
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(["Alpha", "Bravo"]);
	await installedPwa(page, "/index.html");
	// An installed PWA is launched under its worker. (Its page then treats a
	// new worker as an update and reloads onto it; the very first page of a
	// fresh install does not.)
	await page.reload();
	await expect(page.locator(".list-name")).toHaveText(["Alpha", "Bravo"]);
	const svelteShape = await databaseShape(page);

	// 2. Offline edits in the old app: a quick-add and a list rename.
	await context.setOffline(true);
	await page.locator(".list-row", { hasText: "Alpha" }).click();
	await expect(page.locator(".large-title")).toHaveText("Alpha");
	await page.getByRole("textbox", { name: "New task title" }).fill("Milk");
	await page.getByRole("textbox", { name: "New task title" }).press("Enter");
	await page.getByRole("button", { name: "List options" }).click();
	await page.getByRole("button", { name: "Rename List" }).click();
	await page
		.getByRole("alertdialog", { name: "Rename List" })
		.getByRole("textbox")
		.fill("Groceries");
	await page.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(page.locator(".large-title")).toHaveText("Groceries");

	await expect.poll(async () => (await readQueue(page)).length).toBe(2);
	const queued = await readQueue(page);
	expect(queued.map((q) => q.op.kind)).toEqual(["task_create", "list_rename"]);
	expect(pwa.batches).toEqual([]);
	return { queued, svelteShape };
}

/** Wait until the new worker took over and reloaded the page onto the React app. */
async function onReactBuild(page: Page) {
	// The Svelte build's assets live under /_app/, the React build's under /assets/.
	await page.waitForFunction(
		() => !!document.querySelector('link[rel="stylesheet"][href^="/assets/"]'),
		undefined,
		{ timeout: 30_000 },
	);
}

async function runUpdateCheck(page: Page) {
	await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		await registration?.update();
	});
}

test("ops the Svelte build queued offline drain from the React build after the swap", async ({
	page,
	context,
	pwa,
}) => {
	const { queued, svelteShape } = await queueOfflineOnSvelte({
		page,
		context,
		pwa,
	});

	// 3. Deploy the React build, come back online, and let the installed PWA
	// run its update check (what it does hourly and on every foreground).
	pwa.mode = "react";
	pwa.opsNeedClientId = true;
	await context.setOffline(false);
	await runUpdateCheck(page);

	// The new worker takes over and the page reloads onto the React app.
	await onReactBuild(page);
	await expect(page.locator(".large-title")).toHaveText("Groceries");

	// 4. The React build drained the old queue, in order, byte-identical.
	await expect
		.poll(() => pwa.batches.flatMap((b) => b.ops).length, { timeout: 15_000 })
		.toBe(2);
	const sent = pwa.batches.flatMap((b) => b.ops);
	expect(JSON.stringify(sent)).toBe(JSON.stringify(queued.map((q) => q.op)));
	expect(pwa.batches.every((b) => b.clientId !== null)).toBe(true);
	await expect.poll(async () => (await readQueue(page)).length).toBe(0);
	await expect(page.locator(".pill.pending")).toHaveCount(0);

	// Same database, same layout: the React build opened what the Svelte build made.
	expect(await databaseShape(page)).toEqual(svelteShape);
	expect(svelteShape).toEqual({
		version: 2,
		stores: ["dead_ops", "lists", "meta", "op_queue", "tasks"],
	});

	// The old build's caches are gone; the React shell is precached instead.
	await installedPwa(page, "/");
	const cachedPaths = await page.evaluate(async () => {
		const paths: string[] = [];
		for (const name of await caches.keys()) {
			for (const request of await (await caches.open(name)).keys())
				paths.push(new URL(request.url).pathname);
		}
		return { names: await caches.keys(), paths };
	});
	expect(cachedPaths.names).not.toContain("tasks-assets-v1");
	expect(cachedPaths.paths.some((p) => p.startsWith("/_app/"))).toBe(false);
});

test("with no session on the new server, the queue survives both builds' 401 and drains after sign-in", async ({
	page,
	context,
	pwa,
}) => {
	const { queued } = await queueOfflineOnSvelte({ page, context, pwa });

	// 3. The swap as production sees it: the React server has no Better Auth
	// session for this browser and answers /api with a 401 envelope.
	pwa.mode = "react";
	pwa.authenticated = false;
	await context.setOffline(false);

	// The still-running Svelte page syncs on focus before the update check.
	// The server redirects its requests (legacyClientRedirect), so it shows
	// "Session expired", not the Nextcloud reconnect banner, and keeps the queue.
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => pwa.unauthorized).toBeGreaterThan(0);
	await expect(page.getByText("Session expired")).toBeVisible();
	await expect(page.getByText(/Nextcloud connection failed/)).toHaveCount(0);
	expect(await readQueue(page)).toHaveLength(2);
	expect(pwa.batches).toEqual([]);

	// 4. The update check moves the page onto the React build, which also gets
	// a 401 and asks the person to sign in; nothing has been sent or dropped.
	await runUpdateCheck(page);
	await onReactBuild(page);
	const signIn = page.getByRole("button", { name: /session expired/i });
	await expect(signIn).toBeVisible({ timeout: 15_000 });
	expect(await readQueue(page)).toHaveLength(2);
	expect(pwa.batches).toEqual([]);

	// 5. Popup sign-in, then the queue drains byte-identical, nothing dead.
	const [popup] = await Promise.all([
		context.waitForEvent("page"),
		signIn.click(),
	]);
	await popup.getByRole("button", { name: "Continue" }).click();
	await expect
		.poll(() => pwa.batches.flatMap((b) => b.ops).length, { timeout: 15_000 })
		.toBe(2);
	const sent = pwa.batches.flatMap((b) => b.ops);
	expect(JSON.stringify(sent)).toBe(JSON.stringify(queued.map((q) => q.op)));
	await expect.poll(async () => (await readQueue(page)).length).toBe(0);
	expect(await readStore(page, "dead_ops")).toEqual([]);
	await expect(page.locator(".large-title")).toHaveText("Groceries");
});
