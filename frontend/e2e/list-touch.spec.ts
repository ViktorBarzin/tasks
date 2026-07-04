/**
 * Touch e2e for the List screen's per-List sorting (contract delta v1.3):
 *
 *  - the "…" menu's Sort By picker switches Custom / Priority / Due Date, the
 *    open section re-sorts, and the choice persists per device (IndexedDB
 *    meta) across a reload;
 *  - in Custom mode a long-press lifts a task row and a drag two slots down
 *    emits EXACTLY the one midpoint `task_update` op — and the new order
 *    survives a reload;
 *  - in Priority mode a long-press shows nothing (no lift) and a drag attempt
 *    emits no ops and changes no order.
 *
 * Gestures go through CDP `Input.dispatchTouchEvent` — the browser's real
 * input pipeline — exactly like home-touch.spec.ts. `/api` is stubbed
 * statefully: applied `sort_order` updates mutate the tasks the sync
 * endpoint serves, so a reload sees what the "server" now holds.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

interface StubTask {
	uid: string;
	list_id: string;
	title: string;
	notes: string;
	due: string | null;
	due_has_time: boolean;
	priority: number;
	sort_order: number | null;
	completed: boolean;
	completed_at: string | null;
	recurring: boolean;
	deleted: boolean;
}

interface UpdateOp {
	op_id: string;
	kind: string;
	uid: string;
	sort_order?: number | null;
}

const LIST = { id: 'l-a', name: 'Alpha', order: 0, deleted: false };

function seedTasks(): StubTask[] {
	const base = {
		list_id: 'l-a',
		notes: '',
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: false
	};
	// Custom (sort_order): Apples, Bananas, Carrots, Dates
	// Priority:            Bananas(1), Carrots(5), Dates(9), Apples(0)
	// Due Date:            Dates (all-day 07-06), Carrots (07-06 09:00),
	//                      Apples (07-08), Bananas (no due)
	return [
		{ ...base, uid: 't-a', title: 'Apples', due: '2026-07-08', due_has_time: false, priority: 0, sort_order: 1024 },
		{ ...base, uid: 't-b', title: 'Bananas', due: null, due_has_time: false, priority: 1, sort_order: 2048 },
		{ ...base, uid: 't-c', title: 'Carrots', due: '2026-07-06T09:00:00', due_has_time: true, priority: 5, sort_order: 3072 },
		{ ...base, uid: 't-d', title: 'Dates', due: '2026-07-06', due_has_time: false, priority: 9, sort_order: 4096 }
	];
}

/** Stub /api statefully and land on the List screen. */
async function bootList(page: Page): Promise<{ ops: UpdateOp[]; tasks: StubTask[] }> {
	const tasks = seedTasks();
	const ops: UpdateOp[] = [];
	await page.route('**/api/me', (route) =>
		route.fulfill({ json: { username: 'e2e', connected: true } })
	);
	await page.route('**/api/sync**', (route) =>
		route.fulfill({ json: { cursor: 'e2e-cursor', full: true, lists: [LIST], tasks } })
	);
	await page.route('**/api/ops', async (route) => {
		const body = route.request().postDataJSON() as { ops: UpdateOp[] };
		ops.push(...body.ops);
		for (const op of body.ops) {
			if (op.kind !== 'task_update') continue;
			const t = tasks.find((x) => x.uid === op.uid);
			if (t && op.sort_order !== undefined) t.sort_order = op.sort_order;
		}
		await route.fulfill({
			json: { results: body.ops.map((o) => ({ op_id: o.op_id, status: 'applied', error: null })) }
		});
	});
	await page.goto('/list/l-a');
	await expect(titles(page)).toHaveText(['Apples', 'Bananas', 'Carrots', 'Dates']);
	return { ops, tasks };
}

function titles(page: Page) {
	return page.locator('.task-item .title');
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

async function rowBox(page: Page, index: number): Promise<{ x: number; y: number; bottom: number }> {
	const box = await page.locator('[data-drag-item]').nth(index).boundingBox();
	if (!box) throw new Error(`row ${index} has no box`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2, bottom: box.y + box.height };
}

async function pickSortMode(page: Page, current: string, next: string): Promise<void> {
	await page.getByRole('button', { name: 'List options' }).click();
	await page.getByRole('button', { name: `Sort By: ${current}` }).click();
	await page.getByRole('menuitemradio', { name: next }).click();
}

test('Sort By switches Priority → Due Date → Custom, ✓ tracks it, mode persists across reload', async ({
	page
}) => {
	await bootList(page);

	await pickSortMode(page, 'Custom', 'Priority');
	await expect(titles(page)).toHaveText(['Bananas', 'Carrots', 'Dates', 'Apples']);

	// The menu reflects the change: label carries the mode, ✓ sits on it.
	await page.getByRole('button', { name: 'List options' }).click();
	await page.getByRole('button', { name: 'Sort By: Priority' }).click();
	await expect(page.getByRole('menuitemradio', { name: 'Priority' })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await expect(page.getByRole('menuitemradio', { name: 'Custom' })).toHaveAttribute(
		'aria-checked',
		'false'
	);
	await page.getByRole('menuitemradio', { name: 'Due Date' }).click();
	await expect(titles(page)).toHaveText(['Dates', 'Carrots', 'Apples', 'Bananas']);

	// Device-local persistence (IndexedDB meta): the mode survives a reload.
	await page.reload();
	await expect(titles(page)).toHaveText(['Dates', 'Carrots', 'Apples', 'Bananas']);

	await pickSortMode(page, 'Due Date', 'Custom');
	await expect(titles(page)).toHaveText(['Apples', 'Bananas', 'Carrots', 'Dates']);
});

test('Custom mode: long-press-drag two slots emits exactly the midpoint op and survives reload', async ({
	page
}) => {
	const { ops } = await bootList(page);
	const cdp = await page.context().newCDPSession(page);
	const touch = finger(cdp);

	const start = await rowBox(page, 0); // Apples
	await touch.down(start.x, start.y);

	// While the hold timer is pending: nothing visual.
	await page.waitForTimeout(120);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);

	// Past ~350ms of stillness: the row lifts.
	await expect(page.locator('[data-drag-item]').nth(0)).toHaveClass(/drag-lifted/, {
		timeout: 2000
	});

	// Two slots down: align the lifted row's bottom with row 2's bottom —
	// exactly slot 2's center in reorderMath's model (rows may vary in height).
	const target = await rowBox(page, 2); // Carrots
	const dy = target.bottom - start.bottom;
	for (let step = 1; step <= 8; step++) {
		await touch.move(start.x, start.y + (dy * step) / 8);
		await page.waitForTimeout(30);
	}
	await touch.up();

	await expect(titles(page)).toHaveText(['Bananas', 'Carrots', 'Apples', 'Dates']);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);

	// The gesture is a drag, not a tap: no task sheet opened.
	await expect(page.locator('.sheet')).toHaveCount(0);

	// EXACTLY one minimal op: Apples takes the midpoint of Carrots(3072) and
	// Dates(4096); the untouched neighbors emit nothing.
	await expect
		.poll(() => ops.filter((o) => o.kind === 'task_update').length, { timeout: 5000 })
		.toBe(1);
	const update = ops.find((o) => o.kind === 'task_update');
	expect(update).toMatchObject({ uid: 't-a', sort_order: 3584 });
	expect(Object.keys(update as object).sort()).toEqual(['kind', 'op_id', 'sort_order', 'uid']);

	// Persistence: the replica (IndexedDB) and the stateful stub both hold the
	// new key — a reload renders the dragged order.
	await page.reload();
	await expect(titles(page)).toHaveText(['Bananas', 'Carrots', 'Apples', 'Dates']);
});

test('Priority mode: a long-press shows nothing and a drag attempt emits no ops', async ({
	page
}) => {
	const { ops } = await bootList(page);
	await pickSortMode(page, 'Custom', 'Priority');
	await expect(titles(page)).toHaveText(['Bananas', 'Carrots', 'Dates', 'Apples']);

	const cdp = await page.context().newCDPSession(page);
	const touch = finger(cdp);
	const { x, y } = await rowBox(page, 1);
	await touch.down(x, y);
	// Hold well past the lift threshold: nothing lifts in Priority mode.
	await page.waitForTimeout(700);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);
	// Drag anyway — must be a plain scroll gesture, not a reorder.
	for (let step = 1; step <= 5; step++) {
		await touch.move(x, y + step * 14);
		await page.waitForTimeout(25);
	}
	await touch.up();

	await expect(titles(page)).toHaveText(['Bananas', 'Carrots', 'Dates', 'Apples']);
	await page.waitForTimeout(300);
	expect(ops.filter((o) => o.kind === 'task_update')).toHaveLength(0);
});
