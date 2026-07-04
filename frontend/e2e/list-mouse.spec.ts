/**
 * Mouse e2e for the List screen's desktop drag-reorder in Custom sort mode —
 * and its deliberate absence elsewhere:
 *
 *  - Custom mode: a plain press-move-release on a task row lifts within a few
 *    px (no 350ms hold), a two-slot drag emits EXACTLY the one midpoint
 *    `task_update` op (wire shape unchanged from the touch path), and no task
 *    sheet opens (the drag's click is suppressed); a plain click still opens
 *    the sheet;
 *  - Priority mode: a mouse drag does nothing — no lift, no ops, no reorder,
 *    no sheet — and the rows don't advertise a grab cursor.
 *
 * Runs on the desktop-chromium-mouse project (plain Playwright mouse, no
 * touch emulation). `/api` is stubbed like list-touch.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';

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

interface CapturedOp {
	op_id: string;
	kind: string;
	uid?: string;
	list_id?: string;
	sort_order?: number | null;
	sort_mode?: string;
}

const CUSTOM_ORDER = ['Apples', 'Bananas', 'Carrots', 'Dates'];
const PRIORITY_ORDER = ['Bananas', 'Carrots', 'Dates', 'Apples'];

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
	return [
		{ ...base, uid: 't-a', title: 'Apples', due: '2026-07-08', due_has_time: false, priority: 0, sort_order: 1024 },
		{ ...base, uid: 't-b', title: 'Bananas', due: null, due_has_time: false, priority: 1, sort_order: 2048 },
		{ ...base, uid: 't-c', title: 'Carrots', due: '2026-07-06T09:00:00', due_has_time: true, priority: 5, sort_order: 3072 },
		{ ...base, uid: 't-d', title: 'Dates', due: '2026-07-06', due_has_time: false, priority: 9, sort_order: 4096 }
	];
}

/** Stub /api (one List in Custom mode, ops captured + acked) and land on it. */
async function bootList(page: Page): Promise<{ ops: CapturedOp[] }> {
	const list = { id: 'l-a', name: 'Alpha', order: 0, sort_mode: null, deleted: false };
	const ops: CapturedOp[] = [];
	await page.route('**/api/me', (route) =>
		route.fulfill({ json: { username: 'e2e', connected: true } })
	);
	await page.route('**/api/sync**', (route) =>
		route.fulfill({ json: { cursor: 'e2e-cursor', full: true, lists: [list], tasks: seedTasks() } })
	);
	await page.route('**/api/ops', async (route) => {
		const body = route.request().postDataJSON() as { ops: CapturedOp[] };
		ops.push(...body.ops);
		await route.fulfill({
			json: { results: body.ops.map((o) => ({ op_id: o.op_id, status: 'applied', error: null })) }
		});
	});
	await page.goto('/list/l-a');
	await expect(titles(page)).toHaveText(CUSTOM_ORDER);
	return { ops };
}

function titles(page: Page) {
	return page.locator('.task-item .title');
}

async function rowBox(
	page: Page,
	index: number
): Promise<{ x: number; y: number; bottom: number }> {
	const box = await page.locator('[data-drag-item]').nth(index).boundingBox();
	if (!box) throw new Error(`row ${index} has no box`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2, bottom: box.y + box.height };
}

async function pickSortMode(page: Page, current: string, next: string): Promise<void> {
	await page.getByRole('button', { name: 'List options' }).click();
	await page.getByRole('button', { name: `Sort By: ${current}` }).click();
	await page.getByRole('menuitemradio', { name: next }).click();
}

/** Glide the pressed mouse down by `dy` in paced steps (frames between moves). */
async function glideDown(page: Page, x: number, y: number, dy: number): Promise<void> {
	for (let step = 1; step <= 8; step++) {
		await page.mouse.move(x, y + (dy * step) / 8);
		await page.waitForTimeout(30);
	}
}

test('Custom mode: mouse drag two slots emits exactly the midpoint op and opens no sheet', async ({
	page
}) => {
	const { ops } = await bootList(page);
	const start = await rowBox(page, 0); // Apples
	const target = await rowBox(page, 2); // Carrots — measured before anything moves

	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	// ~10px of pressed travel: the lift is immediate — no stationary hold.
	await page.mouse.move(start.x, start.y + 10);
	await expect(page.locator('[data-drag-item]').nth(0)).toHaveClass(/drag-lifted/);

	// Two slots down: align the lifted row's bottom with row 2's bottom —
	// exactly slot 2's center in reorderMath's model (rows may vary in height).
	await glideDown(page, start.x, start.y, target.bottom - start.bottom);
	await page.mouse.up();

	await expect(titles(page)).toHaveText(['Bananas', 'Carrots', 'Apples', 'Dates']);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);

	// The gesture is a drag, not a click: its click is suppressed, no sheet.
	await page.waitForTimeout(300);
	await expect(page.locator('.sheet')).toHaveCount(0);

	// EXACTLY one minimal op: Apples takes the midpoint of Carrots(3072) and
	// Dates(4096); the untouched neighbors emit nothing.
	await expect
		.poll(() => ops.filter((o) => o.kind === 'task_update').length, { timeout: 5000 })
		.toBe(1);
	const update = ops.find((o) => o.kind === 'task_update');
	expect(update).toMatchObject({ uid: 't-a', sort_order: 3584 });
	expect(Object.keys(update as object).sort()).toEqual(['kind', 'op_id', 'sort_order', 'uid']);
});

test('Custom mode: a plain click on a task row still opens the task sheet', async ({ page }) => {
	await bootList(page);
	await titles(page).first().click();
	await expect(page.locator('.sheet')).toHaveCount(1);
});

test('grab affordance follows draggability: Custom rows advertise it, Priority rows do not', async ({
	page
}) => {
	await bootList(page);
	const cursor = () =>
		page
			.locator('[data-drag-item]')
			.first()
			.evaluate((el) => getComputedStyle(el).cursor);
	expect(await cursor()).toBe('grab');

	await pickSortMode(page, 'Custom', 'Priority');
	await expect(titles(page)).toHaveText(PRIORITY_ORDER);
	expect(await cursor()).not.toBe('grab');
});

test('Priority mode: a mouse drag does nothing — no lift, no ops, order unchanged', async ({
	page
}) => {
	const { ops } = await bootList(page);
	await pickSortMode(page, 'Custom', 'Priority');
	await expect(titles(page)).toHaveText(PRIORITY_ORDER);

	const { x, y } = await rowBox(page, 1);
	await page.mouse.move(x, y);
	await page.mouse.down();
	await glideDown(page, x, y, 84);
	await expect(page.locator('.drag-lifted')).toHaveCount(0);
	await page.mouse.up();

	await expect(titles(page)).toHaveText(PRIORITY_ORDER);
	await page.waitForTimeout(300);
	await expect(page.locator('.sheet')).toHaveCount(0);
	expect(ops.filter((o) => o.kind === 'task_update')).toHaveLength(0);
});
