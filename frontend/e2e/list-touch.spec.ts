/**
 * Touch e2e for the List screen's per-List sorting (contract deltas v1.3/v1.4):
 *
 *  - the "…" menu's Sort By picker switches Custom / Priority / Due Date, the
 *    open section re-sorts, every change emits a `list_set_sort_mode` op on
 *    the wire, and the mode persists across a reload FROM THE SERVER payload
 *    (the stateful stub applies the op to the List it serves — v1.4);
 *  - a server-synced mode beats a stale device-local IndexedDB meta, and a
 *    null server value falls back to that meta WITHOUT auto-pushing it;
 *  - in Custom mode a long-press lifts a task row and a drag two slots down
 *    emits EXACTLY the one midpoint `task_update` op — and the new order
 *    survives a reload;
 *  - in Priority mode a long-press shows nothing (no lift) and a drag attempt
 *    emits no ops and changes no order.
 *
 * Gestures go through CDP `Input.dispatchTouchEvent` — the browser's real
 * input pipeline — exactly like home-touch.spec.ts. `/api` is stubbed
 * statefully: applied `sort_order` updates and `list_set_sort_mode` ops
 * mutate what the sync endpoint serves, so a reload sees what the "server"
 * now holds.
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

interface StubList {
	id: string;
	name: string;
	order: number;
	sort_mode: string | null;
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
const DUE_ORDER = ['Dates', 'Carrots', 'Apples', 'Bananas'];

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

/**
 * Stub /api statefully and land on the List screen. `serverSortMode` is what
 * the "server" holds for the List (v1.4); `initialTitles` doubles as the
 * app-ready wait and pins which mode actually renders.
 */
async function bootList(
	page: Page,
	serverSortMode: string | null = null,
	initialTitles: string[] = CUSTOM_ORDER
): Promise<{ ops: CapturedOp[]; tasks: StubTask[]; list: StubList }> {
	const tasks = seedTasks();
	const list: StubList = {
		id: 'l-a',
		name: 'Alpha',
		order: 0,
		sort_mode: serverSortMode,
		deleted: false
	};
	const ops: CapturedOp[] = [];
	await page.route('**/api/me', (route) =>
		route.fulfill({ json: { username: 'e2e', connected: true } })
	);
	await page.route('**/api/sync**', (route) =>
		route.fulfill({ json: { cursor: 'e2e-cursor', full: true, lists: [list], tasks } })
	);
	await page.route('**/api/ops', async (route) => {
		const body = route.request().postDataJSON() as { ops: CapturedOp[] };
		ops.push(...body.ops);
		for (const op of body.ops) {
			if (op.kind === 'task_update') {
				const t = tasks.find((x) => x.uid === op.uid);
				if (t && op.sort_order !== undefined) t.sort_order = op.sort_order;
			}
			// The mode op mutates the List the sync endpoint serves — a reload
			// then restores the mode from the SERVER payload (v1.4 §1).
			if (op.kind === 'list_set_sort_mode' && op.sort_mode !== undefined) {
				list.sort_mode = op.sort_mode;
			}
		}
		await route.fulfill({
			json: { results: body.ops.map((o) => ({ op_id: o.op_id, status: 'applied', error: null })) }
		});
	});
	await page.goto('/list/l-a');
	await expect(titles(page)).toHaveText(initialTitles);
	return { ops, tasks, list };
}

/**
 * Write the pre-v0.5 device-local mode meta (`sort_mode:<listId>`) into
 * IndexedDB from a blank same-origin page BEFORE the app ever runs — exactly
 * the leftover an older build would have. The schema must mirror db.ts
 * DB_NAME='tasks' / DB_VERSION=2, or the app's own open would miss stores.
 */
async function seedDeviceLocalSortMode(page: Page, listId: string, mode: string): Promise<void> {
	await page.route('**/__seed', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' })
	);
	await page.goto('/__seed');
	await page.evaluate(
		async ({ key, value }) => {
			await new Promise<void>((resolve, reject) => {
				const openReq = indexedDB.open('tasks', 2);
				openReq.onupgradeneeded = () => {
					const d = openReq.result;
					d.createObjectStore('lists', { keyPath: 'id' });
					d.createObjectStore('tasks', { keyPath: 'uid' }).createIndex('by-list', 'list_id');
					d.createObjectStore('meta', { keyPath: 'key' });
					d.createObjectStore('op_queue', { keyPath: 'seq', autoIncrement: true });
					d.createObjectStore('dead_ops', { keyPath: 'seq', autoIncrement: true });
				};
				openReq.onsuccess = () => {
					const d = openReq.result;
					const tx = d.transaction('meta', 'readwrite');
					tx.objectStore('meta').put({ key, value });
					tx.oncomplete = () => {
						d.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error ?? new Error('meta seed failed'));
				};
				openReq.onerror = () => reject(openReq.error ?? new Error('idb open failed'));
			});
		},
		{ key: `sort_mode:${listId}`, value: mode }
	);
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

test('Sort By switches Priority → Due Date → Custom, ✓ tracks it, each change hits the wire, the SERVER payload restores it after reload', async ({
	page
}) => {
	const { ops, list } = await bootList(page);

	await pickSortMode(page, 'Custom', 'Priority');
	await expect(titles(page)).toHaveText(PRIORITY_ORDER);

	// The change traveled as ONE list_set_sort_mode op carrying exactly the
	// contract's fields (v1.4 §2), and the stateful stub's List now holds it.
	await expect
		.poll(() => ops.filter((o) => o.kind === 'list_set_sort_mode').length, { timeout: 5000 })
		.toBe(1);
	const modeOp = ops.find((o) => o.kind === 'list_set_sort_mode');
	expect(modeOp).toMatchObject({ list_id: 'l-a', sort_mode: 'priority' });
	expect(Object.keys(modeOp as object).sort()).toEqual(['kind', 'list_id', 'op_id', 'sort_mode']);
	expect(list.sort_mode).toBe('priority');

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
	await expect(titles(page)).toHaveText(DUE_ORDER);
	await expect
		.poll(() => ops.filter((o) => o.kind === 'list_set_sort_mode').length, { timeout: 5000 })
		.toBe(2);
	expect(list.sort_mode).toBe('due');

	// Shared persistence (v1.4): the reload rebuilds from the SERVER payload,
	// which now carries the mode — exactly what every other household device
	// receives on its next sync cycle.
	await page.reload();
	await expect(titles(page)).toHaveText(DUE_ORDER);

	await pickSortMode(page, 'Due Date', 'Custom');
	await expect(titles(page)).toHaveText(CUSTOM_ORDER);
});

test('a server-synced mode beats a stale device-local one (v1.4: server wins)', async ({
	page
}) => {
	// An old build on this device left meta saying Due Date; the household has
	// since set Priority (server value present) — the server must win.
	await seedDeviceLocalSortMode(page, 'l-a', 'due');
	await bootList(page, 'priority', PRIORITY_ORDER);

	// The picker's ✓ agrees with what rendered.
	await page.getByRole('button', { name: 'List options' }).click();
	await page.getByRole('button', { name: 'Sort By: Priority' }).click();
	await expect(page.getByRole('menuitemradio', { name: 'Priority' })).toHaveAttribute(
		'aria-checked',
		'true'
	);
});

test('a null server mode falls back to the device-local meta and is never auto-pushed', async ({
	page
}) => {
	await seedDeviceLocalSortMode(page, 'l-a', 'due');
	const { ops } = await bootList(page, null, DUE_ORDER);

	// The fallback renders, but nothing goes to the wire by itself — only a
	// user-initiated picker change lands the mode server-side (v1.4 §3).
	await page.waitForTimeout(400);
	expect(ops.filter((o) => o.kind === 'list_set_sort_mode')).toHaveLength(0);
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
