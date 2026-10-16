/**
 * Realtime pokes (ADR-0001, Pilot / Realtime): an op sent through tasks pokes
 * the same user's other open devices over /api/events, and they run a delta
 * sync. The stub origin (e2e/fixtures/pwa-server.ts) plays the server: it
 * changes what /api/sync returns and pushes the SSE events.
 */
import { expect, test } from "../fixtures/pwa";

test("another device's poke pulls its change in, with no reload or focus", async ({
	page,
	pwa,
}) => {
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(["Alpha", "Bravo"]);
	await expect.poll(() => pwa.openStreams()).toBe(1);

	// Another device added a List; the server pokes this one.
	pwa.lists.push({
		id: "l-c",
		name: "Charlie",
		order: 2,
		sort_mode: null,
		deleted: false,
	});
	pwa.push("poke", { type: "poke", source_client_id: "another-device" });

	await expect(page.locator(".list-name")).toHaveText([
		"Alpha",
		"Bravo",
		"Charlie",
	]);
});

test("the poke this device's own ops caused does not trigger another sync", async ({
	page,
	pwa,
}) => {
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(["Alpha", "Bravo"]);
	await expect.poll(() => pwa.openStreams()).toBe(1);

	// Send an op so the server learns this tab's client id.
	await page.getByRole("button", { name: "Add List" }).click();
	await page
		.getByRole("alertdialog", { name: "New List" })
		.getByRole("textbox")
		.fill("Errands");
	await page.getByRole("button", { name: "Create" }).click();
	await expect.poll(() => pwa.batches.length).toBe(1);
	const own = pwa.batches[0]?.clientId;
	expect(own).toBeTruthy();

	// Let the sync that follows the op settle, then poke with our own id.
	await page.waitForTimeout(500);
	const before = pwa.syncCount;
	pwa.push("poke", { type: "poke", source_client_id: own });
	await page.waitForTimeout(800);
	expect(pwa.syncCount).toBe(before);

	// A poke from anyone else still syncs.
	pwa.push("poke", { type: "poke", source_client_id: "another-device" });
	await expect.poll(() => pwa.syncCount).toBe(before + 1);
});

test("a `resync` event and an SSE reconnect both run a sync (events may have been lost)", async ({
	page,
	pwa,
}) => {
	await page.goto(`${pwa.appUrl}/`);
	await expect(page.locator(".list-name")).toHaveText(["Alpha", "Bravo"]);
	await expect.poll(() => pwa.openStreams()).toBe(1);
	await page.waitForTimeout(300);

	let before = pwa.syncCount;
	pwa.push("resync", { type: "resync" });
	await expect.poll(() => pwa.syncCount).toBeGreaterThan(before);

	// The stream drops (pod restart); the browser reconnects (retry: 500 ms)
	// and the client syncs on the new connection.
	await page.waitForTimeout(300);
	before = pwa.syncCount;
	pwa.dropStreams();
	await expect.poll(() => pwa.openStreams(), { timeout: 5000 }).toBe(1);
	await expect.poll(() => pwa.syncCount).toBeGreaterThan(before);
});
