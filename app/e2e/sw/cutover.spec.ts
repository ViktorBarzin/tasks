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
 * The stub holds back POST /api/ops that lack X-Tasks-Client-Id (503, which
 * both builds treat as "retry later") after the swap, so the ops cannot be
 * drained by the old page while the new worker installs: what arrives was
 * sent by the React build.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, installedPwa, test } from "../fixtures/pwa";
import { SVELTE_BUILD } from "../global-setup";

interface QueuedRow {
	seq: number;
	op: { op_id: string; kind: string; [key: string]: unknown };
	enqueuedAt: number;
	attempts: number;
}

/** The raw `op_queue` rows, read straight from IndexedDB (name `tasks`, v2). */
async function readQueue(page: Page): Promise<QueuedRow[]> {
	return page.evaluate(
		() =>
			new Promise<QueuedRow[]>((resolve, reject) => {
				const open = indexedDB.open("tasks");
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const req = db
						.transaction("op_queue")
						.objectStore("op_queue")
						.getAll();
					req.onsuccess = () => {
						db.close();
						resolve(req.result as QueuedRow[]);
					};
					req.onerror = () => reject(req.error);
				};
			}),
	);
}

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

test("ops the Svelte build queued offline drain from the React build after the swap", async ({
	page,
	context,
	pwa,
}) => {
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

	// 3. Deploy the React build, come back online, and let the installed PWA
	// run its update check (what it does hourly and on every foreground).
	pwa.mode = "react";
	pwa.opsNeedClientId = true;
	await context.setOffline(false);
	await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		await registration?.update();
	});

	// The new worker takes over and the page reloads onto the React app.
	// (The Svelte build's assets live under /_app/, the React build's under /assets/.)
	await page.waitForFunction(
		() => !!document.querySelector('link[rel="stylesheet"][href^="/assets/"]'),
		undefined,
		{ timeout: 30_000 },
	);
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
