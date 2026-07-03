/**
 * Touch e2e for the Home screen's Reminders-parity reordering:
 *
 *  - long-press anywhere on a List row lifts it (no Edit mode), a drag
 *    reorders, the drop emits minimal `list_reorder` ops, and the gesture
 *    NEVER navigates;
 *  - a quick tap still navigates (rows are role="link" divs — Home renders no
 *    anchors at all, so iOS structurally cannot show a link preview);
 *  - finger travel during the hold window is a scroll: the lift is cancelled;
 *  - `contextmenu` inside the list container is always defaultPrevented;
 *  - Edit mode's drag handles keep the immediate (no-hold) grab.
 *
 * Gestures go through CDP `Input.dispatchTouchEvent` — the browser's real
 * input pipeline (pointer events, gesture arbitration, click synthesis) — not
 * synthetic DOM events. `/api` is stubbed: sync serves three Lists, ops are
 * captured for assertion.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

const LISTS = [
	{ id: 'l-a', name: 'Alpha', order: 0, deleted: false },
	{ id: 'l-b', name: 'Bravo', order: 1, deleted: false },
	{ id: 'l-c', name: 'Charlie', order: 2, deleted: false }
];

interface ReorderOp {
	op_id: string;
	kind: string;
	list_id: string;
	order: number;
}

/** Stub /api (3 Lists, ops captured + acked "applied") and land on Home. */
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
	await expect(page.locator('.list-name')).toHaveText(['Alpha', 'Bravo', 'Charlie']);
	return { ops: captured };
}

/** Single-finger touch driver over the REAL input pipeline (CDP). */
function finger(cdp: CDPSession) {
	return {
		down: (x: number, y: number) =>
			cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }),
		move: (x: number, y: number) =>
			cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }),
		up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
	};
}

async function rowCenter(page: Page, index: number): Promise<{ x: number; y: number }> {
	const box = await page.locator('[data-drag-item]').nth(index).boundingBox();
	if (!box) throw new Error(`row ${index} has no box`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('home renders no anchors — iOS link preview is structurally impossible', async ({ page }) => {
	await bootHome(page);
	expect(await page.locator('a[href]').count()).toBe(0);
	// Navigation semantics survive for a11y: the rows and tiles are links to AT.
	await expect(page.getByRole('link', { name: /Bravo/ })).toBeVisible();
	await expect(page.getByRole('link', { name: /Today/ })).toBeVisible();
});

test('long-press lifts, drag reorders with minimal ops, and never navigates', async ({ page }) => {
	const { ops } = await bootHome(page);
	const cdp = await page.context().newCDPSession(page);
	const touch = finger(cdp);

	const { x, y } = await rowCenter(page, 1); // Bravo
	await touch.down(x, y);

	// While the hold timer is pending: nothing visual.
	await page.waitForTimeout(120);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);

	// Past ~350ms of stillness: the row lifts.
	await expect(page.locator('[data-drag-item]').nth(1)).toHaveClass(/drag-lifted/, {
		timeout: 2000
	});

	// Drag down ~1.15 row heights, then drop.
	for (let step = 1; step <= 6; step++) {
		await touch.move(x, y + step * 10);
		await page.waitForTimeout(30);
	}
	await touch.up();

	await expect(page.locator('.list-name')).toHaveText(['Alpha', 'Charlie', 'Bravo']);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);

	// The gesture is a drag, not a tap: still on Home.
	await page.waitForTimeout(300);
	expect(new URL(page.url()).pathname).toBe('/');

	// Minimal ops: only the two Lists whose order changed (Alpha untouched).
	await expect
		.poll(() => ops.filter((o) => o.kind === 'list_reorder').length, { timeout: 5000 })
		.toBe(2);
	const byList = new Map(ops.map((o) => [o.list_id, o.order]));
	expect(byList.get('l-c')).toBe(1);
	expect(byList.get('l-b')).toBe(2);
	expect(byList.has('l-a')).toBe(false);
});

test('a quick tap on a row navigates to the List', async ({ page }) => {
	await bootHome(page);
	const cdp = await page.context().newCDPSession(page);
	const touch = finger(cdp);

	const { x, y } = await rowCenter(page, 0); // Alpha
	await touch.down(x, y);
	await page.waitForTimeout(60);
	await touch.up();

	await expect(page).toHaveURL(/\/list\/l-a$/);
});

test('finger travel during the hold is a scroll: lift cancelled, no ops, no navigation', async ({
	page
}) => {
	const { ops } = await bootHome(page);
	const cdp = await page.context().newCDPSession(page);
	const touch = finger(cdp);

	const { x, y } = await rowCenter(page, 1);
	await touch.down(x, y);
	// >8px of travel inside the hold window — a scroll, not a press.
	for (let step = 1; step <= 3; step++) {
		await touch.move(x, y + step * 12);
		await page.waitForTimeout(25);
	}
	// Keep holding well past the timer: it must have been cancelled.
	await page.waitForTimeout(600);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);
	await touch.up();

	await page.waitForTimeout(300);
	expect(new URL(page.url()).pathname).toBe('/');
	expect(ops.filter((o) => o.kind === 'list_reorder')).toHaveLength(0);
});

test('contextmenu inside the list container is defaultPrevented', async ({ page }) => {
	await bootHome(page);
	const prevented = await page.evaluate(() => {
		const row = document.querySelector('[data-drag-item]');
		if (!row) throw new Error('no row');
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		return !row.dispatchEvent(ev); // false return = preventDefault was called
	});
	expect(prevented).toBe(true);
});

test('Edit mode: handle drag engages immediately (no hold delay), same minimal ops', async ({
	page
}) => {
	const { ops } = await bootHome(page);
	await page.getByRole('button', { name: 'Edit' }).click();
	await expect(page.locator('[data-drag-handle]')).toHaveCount(3);

	const cdp = await page.context().newCDPSession(page);
	const touch = finger(cdp);
	const handle = await page.locator('[data-drag-handle]').first().boundingBox();
	if (!handle) throw new Error('no handle box');
	const x = handle.x + handle.width / 2;
	const y = handle.y + handle.height / 2;

	await touch.down(x, y);
	// Immediate grab — long before the 350ms hold threshold.
	await expect(page.locator('[data-drag-item]').first()).toHaveClass(/drag-lifted/, {
		timeout: 300
	});
	for (let step = 1; step <= 6; step++) {
		await touch.move(x, y + step * 10);
		await page.waitForTimeout(30);
	}
	await touch.up();

	await expect(page.locator('.list-name')).toHaveText(['Bravo', 'Alpha', 'Charlie']);
	await expect
		.poll(() => ops.filter((o) => o.kind === 'list_reorder').length, { timeout: 5000 })
		.toBe(2);
	const byList = new Map(ops.map((o) => [o.list_id, o.order]));
	expect(byList.get('l-b')).toBe(0);
	expect(byList.get('l-a')).toBe(1);
});
