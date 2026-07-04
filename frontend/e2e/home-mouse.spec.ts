/**
 * Mouse e2e for the Home screen's desktop drag-reorder — the same engine the
 * touch specs cover, engaged desktop-style (pointerType-aware holdGesture):
 *
 *  - a plain press-move-release on a List row lifts as soon as the pointer
 *    travels a few px (NO 350ms stationary hold — before pointerType-aware
 *    engagement this exact gesture cancelled the lift and navigated instead),
 *    reorders, emits minimal `list_reorder` ops, and never navigates;
 *  - while the drag is live the document shows `cursor: grabbing` and text
 *    selection is off everywhere; both restore on drop;
 *  - a plain click still navigates, and so does a sub-threshold press-wiggle;
 *  - fine-pointer affordance: reorderable rows advertise `cursor: grab`;
 *  - Edit mode's drag handle engages immediately with the mouse too.
 *
 * Runs on the desktop-chromium-mouse project: default Playwright mouse input
 * (real CDP mouse events, no touch emulation). `/api` is stubbed: sync serves
 * FOUR Lists — a two-slot drag then leaves one List untouched, which is what
 * makes the minimal-ops assertion meaningful. Wire shape is unchanged from
 * the touch path: the drop emits the same minimal ops.
 */
import { expect, test, type Page } from '@playwright/test';

const LISTS = [
	{ id: 'l-a', name: 'Alpha', order: 0, sort_mode: null, deleted: false },
	{ id: 'l-b', name: 'Bravo', order: 1, sort_mode: null, deleted: false },
	{ id: 'l-c', name: 'Charlie', order: 2, sort_mode: null, deleted: false },
	{ id: 'l-d', name: 'Delta', order: 3, sort_mode: null, deleted: false }
];

interface ReorderOp {
	op_id: string;
	kind: string;
	list_id: string;
	order: number;
}

/** Stub /api (4 Lists, ops captured + acked "applied") and land on Home. */
async function bootHome(page: Page): Promise<{ ops: ReorderOp[] }> {
	const captured: ReorderOp[] = [];
	await page.route('**/api/me', (route) =>
		route.fulfill({ json: { username: 'e2e', connected: true } })
	);
	await page.route('**/api/sync**', (route) =>
		route.fulfill({ json: { cursor: 'e2e-cursor', full: true, lists: LISTS, tasks: [] } })
	);
	await page.route('**/api/ops', async (route) => {
		const body = route.request().postDataJSON() as { ops: ReorderOp[] };
		captured.push(...body.ops);
		await route.fulfill({
			json: { results: body.ops.map((o) => ({ op_id: o.op_id, status: 'applied', error: null })) }
		});
	});
	await page.goto('/');
	await expect(page.locator('.list-name')).toHaveText(['Alpha', 'Bravo', 'Charlie', 'Delta']);
	return { ops: captured };
}

async function rowCenter(page: Page, index: number): Promise<{ x: number; y: number }> {
	const box = await page.locator('[data-drag-item]').nth(index).boundingBox();
	if (!box) throw new Error(`row ${index} has no box`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Glide the pressed mouse to (x, y) in paced steps — real frames between
 * moves, since the drop commits whatever the last rAF tick computed. */
async function glideTo(page: Page, x: number, y: number, from: { x: number; y: number }) {
	for (let step = 1; step <= 8; step++) {
		await page.mouse.move(from.x + ((x - from.x) * step) / 8, from.y + ((y - from.y) * step) / 8);
		await page.waitForTimeout(30);
	}
}

test('press-move-release drags a List two slots: minimal ops, no navigation, no hold', async ({
	page
}) => {
	const { ops } = await bootHome(page);
	const alpha = await rowCenter(page, 0);
	const charlie = await rowCenter(page, 2); // measured before anything moves

	await page.mouse.move(alpha.x, alpha.y);
	await page.mouse.down();
	// ~10px of pressed travel lifts immediately — no stationary hold happened
	// anywhere in this gesture (the whole drag stays under the 350ms window).
	await page.mouse.move(alpha.x, alpha.y + 10);
	await expect(page.locator('[data-drag-item]').nth(0)).toHaveClass(/drag-lifted/);

	// Desktop affordances while the drag is live: grabbing + no selection,
	// document-wide.
	expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe('grabbing');
	expect(await page.evaluate(() => getComputedStyle(document.body).userSelect)).toBe('none');

	await glideTo(page, alpha.x, charlie.y, { x: alpha.x, y: alpha.y + 10 });
	await page.mouse.up();

	await expect(page.locator('.list-name')).toHaveText(['Bravo', 'Charlie', 'Alpha', 'Delta']);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);
	expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).not.toBe('grabbing');

	// The gesture is a drag, not a click: still on Home.
	await page.waitForTimeout(300);
	expect(new URL(page.url()).pathname).toBe('/');

	// Minimal ops: only the three Lists whose order changed (Delta untouched).
	await expect
		.poll(() => ops.filter((o) => o.kind === 'list_reorder').length, { timeout: 5000 })
		.toBe(3);
	const byList = new Map(ops.map((o) => [o.list_id, o.order]));
	expect(byList.get('l-b')).toBe(0);
	expect(byList.get('l-c')).toBe(1);
	expect(byList.get('l-a')).toBe(2);
	expect(byList.has('l-d')).toBe(false);
});

test('a plain click on a row still navigates to the List', async ({ page }) => {
	await bootHome(page);
	await page.locator('[data-drag-item]').nth(0).click();
	await expect(page).toHaveURL(/\/list\/l-a$/);
});

test('a sub-threshold press-wiggle-release is still a click and navigates', async ({ page }) => {
	await bootHome(page);
	const alpha = await rowCenter(page, 0);
	await page.mouse.move(alpha.x, alpha.y);
	await page.mouse.down();
	await page.mouse.move(alpha.x + 2, alpha.y + 2); // ~2.8px < the ~5px threshold
	await page.mouse.up();
	await expect(page).toHaveURL(/\/list\/l-a$/);
});

test('reorderable rows advertise cursor: grab on fine-pointer devices', async ({ page }) => {
	await bootHome(page);
	const cursor = await page
		.locator('[data-drag-item]')
		.nth(0)
		.evaluate((el) => getComputedStyle(el).cursor);
	expect(cursor).toBe('grab');
});

test('Edit mode: the drag handle engages immediately with the mouse, same minimal ops', async ({
	page
}) => {
	const { ops } = await bootHome(page);
	await page.getByRole('button', { name: 'Edit' }).click();
	await expect(page.locator('[data-drag-handle]')).toHaveCount(4);

	const handle = await page.locator('[data-drag-handle]').first().boundingBox();
	if (!handle) throw new Error('no handle box');
	const rowBox = await page.locator('[data-drag-item]').first().boundingBox();
	if (!rowBox) throw new Error('no row box');
	const x = handle.x + handle.width / 2;
	const y = handle.y + handle.height / 2;

	await page.mouse.move(x, y);
	await page.mouse.down();
	// The grab is at pointerdown — zero travel, zero hold.
	await expect(page.locator('[data-drag-item]').first()).toHaveClass(/drag-lifted/, {
		timeout: 300
	});
	await glideTo(page, x, y + rowBox.height, { x, y });
	await page.mouse.up();

	await expect(page.locator('.list-name')).toHaveText(['Bravo', 'Alpha', 'Charlie', 'Delta']);
	await expect
		.poll(() => ops.filter((o) => o.kind === 'list_reorder').length, { timeout: 5000 })
		.toBe(2);
	const byList = new Map(ops.map((o) => [o.list_id, o.order]));
	expect(byList.get('l-b')).toBe(0);
	expect(byList.get('l-a')).toBe(1);
});
