import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	completeTask,
	createList,
	createTask,
	deleteList,
	deleteTask,
	moveTask,
	recentlyCompleted,
	renameList,
	reorderLists,
	reorderTasks,
	uncompleteTask,
	updateTask
} from './actions';
import * as db from './db';
import { _resetReplicaForTests, replica } from './replica';
import { _resetSyncForTests } from './sync';
import type {
	ListReorderOp,
	TaskCompleteOp,
	TaskCreateOp,
	TaskMoveOp,
	TaskUpdateOp
} from './types';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	db._resetForTests();
	_resetReplicaForTests();
	_resetSyncForTests();
	recentlyCompleted.set(new Set());
	// Actions kick the sync engine; keep the network out of unit tests.
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});

describe('actions', () => {
	it('createTask applies optimistically and enqueues a task_create with a client uuid', async () => {
		const listId = await createList('Groceries');
		const uid = await createTask(listId, { title: 'Buy milk', priority: 5 });

		const state = get(replica);
		expect(state.tasks.get(uid)).toMatchObject({ title: 'Buy milk', priority: 5, completed: false });

		const queued = await db.peekOps(10);
		expect(queued.map((q) => q.op.kind)).toEqual(['list_create', 'task_create']);
		const createOp = queued[1]!.op as TaskCreateOp;
		expect(createOp.uid).toBe(uid);
		expect(createOp.uid).toMatch(/^[0-9a-f-]{36}$/);
		expect(createOp.op_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(createOp.op_id).not.toBe(createOp.uid);
	});

	it('complete/uncomplete round-trips and manages the grace set', async () => {
		const listId = await createList('L');
		const uid = await createTask(listId, { title: 't' });

		await completeTask(uid);
		expect(get(replica).tasks.get(uid)?.completed).toBe(true);
		expect(get(recentlyCompleted).has(uid)).toBe(true);

		await uncompleteTask(uid);
		expect(get(replica).tasks.get(uid)?.completed).toBe(false);
		expect(get(recentlyCompleted).has(uid)).toBe(false);
	});

	it('completeTask carries completed_at + the current DUE as occurrence_due (§C)', async () => {
		const listId = await createList('L');
		const uid = await createTask(listId, { title: 'weekly', due: '2026-07-10' });

		await completeTask(uid);

		const op = (await db.peekOps(20)).find((q) => q.op.kind === 'task_complete')!
			.op as TaskCompleteOp;
		expect(op.occurrence_due).toBe('2026-07-10');
		expect(op.completed_at).toMatch(/^\d{4}-\d\d-\d\dT/);
	});

	it('update, move, delete mutate the replica and queue ops in order', async () => {
		const a = await createList('A');
		const b = await createList('B');
		const uid = await createTask(a, { title: 'x' });

		await updateTask(uid, { title: 'renamed', due: '2026-07-09', due_has_time: false });
		await moveTask(uid, b, a);
		expect(get(replica).tasks.get(uid)).toMatchObject({ title: 'renamed', list_id: b });

		await deleteTask(uid);
		expect(get(replica).tasks.has(uid)).toBe(false);

		const kinds = (await db.peekOps(20)).map((q) => q.op.kind);
		expect(kinds).toEqual([
			'list_create',
			'list_create',
			'task_create',
			'task_update',
			'task_move',
			'task_delete'
		]);
	});

	it('moveTask records both the source and destination List (contract §A)', async () => {
		const a = await createList('A');
		const b = await createList('B');
		const uid = await createTask(a, { title: 'x' });

		await moveTask(uid, b, a);

		const moveOp = (await db.peekOps(20)).find((q) => q.op.kind === 'task_move')!.op as TaskMoveOp;
		expect(moveOp.list_id).toBe(a); // source
		expect(moveOp.to_list_id).toBe(b); // destination
		expect(get(replica).tasks.get(uid)?.list_id).toBe(b);
	});

	it('reorderLists emits one list_reorder op per change and applies optimistically', async () => {
		const a = await createList('A');
		const b = await createList('B');

		await reorderLists([
			{ listId: b, order: 0 },
			{ listId: a, order: 1 }
		]);

		const state = get(replica);
		expect(state.lists.get(b)?.order).toBe(0);
		expect(state.lists.get(a)?.order).toBe(1);

		const reorders = (await db.peekOps(20))
			.filter((q) => q.op.kind === 'list_reorder')
			.map((q) => q.op as ListReorderOp);
		expect(reorders.map((o) => [o.list_id, o.order])).toEqual([
			[b, 0],
			[a, 1]
		]);
		for (const o of reorders) expect(o.op_id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('reorderLists with no changes records nothing', async () => {
		await reorderLists([]);
		expect(await db.peekOps(10)).toEqual([]);
	});

	it('createTask lands at the bottom of the open section: max concrete key + 1024', async () => {
		const listId = await createList('L');
		const first = await createTask(listId, { title: 'first' });
		const second = await createTask(listId, { title: 'second' });
		const other = await createList('Other');
		const elsewhere = await createTask(other, { title: 'unrelated' });

		const state = get(replica);
		expect(state.tasks.get(first)?.sort_order).toBe(1024);
		expect(state.tasks.get(second)?.sort_order).toBe(2048);
		// Keys are per List — the other List starts its own chain.
		expect(state.tasks.get(elsewhere)?.sort_order).toBe(1024);

		const creates = (await db.peekOps(20))
			.filter((q) => q.op.kind === 'task_create')
			.map((q) => q.op as TaskCreateOp);
		expect(creates.map((o) => o.sort_order)).toEqual([1024, 2048, 1024]);
	});

	it('createTask honors an explicitly pinned sort_order (including null)', async () => {
		const listId = await createList('L');
		const pinned = await createTask(listId, { title: 'pinned', sort_order: 99 });
		const nulled = await createTask(listId, { title: 'nulled', sort_order: null });
		const state = get(replica);
		expect(state.tasks.get(pinned)?.sort_order).toBe(99);
		expect(state.tasks.get(nulled)?.sort_order).toBeNull();
	});

	it('reorderTasks emits one MINIMAL task_update per change and applies optimistically', async () => {
		const listId = await createList('L');
		const a = await createTask(listId, { title: 'a' }); // 1024
		const b = await createTask(listId, { title: 'b' }); // 2048
		await createTask(listId, { title: 'c' }); // 3072 — untouched by the plan

		// Drag a below b: planTaskReorder would emit exactly one change.
		await reorderTasks([{ uid: a, sort_order: 2560 }]);

		expect(get(replica).tasks.get(a)?.sort_order).toBe(2560);
		expect(get(replica).tasks.get(b)?.sort_order).toBe(2048);

		const updates = (await db.peekOps(20)).filter((q) => q.op.kind === 'task_update');
		expect(updates).toHaveLength(1);
		const op = updates[0]!.op as TaskUpdateOp;
		expect(op.uid).toBe(a);
		expect(op.sort_order).toBe(2560);
		expect(op.title).toBeUndefined(); // sort_order-only patch
		expect(op.op_id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('reorderTasks with no changes records nothing', async () => {
		await reorderTasks([]);
		expect(await db.peekOps(10)).toEqual([]);
	});

	it('renameList and deleteList cascade locally', async () => {
		const a = await createList('A');
		await createTask(a, { title: 'inside' });
		await renameList(a, 'A2');
		expect(get(replica).lists.get(a)?.name).toBe('A2');

		await deleteList(a);
		const state = get(replica);
		expect(state.lists.has(a)).toBe(false);
		expect(state.tasks.size).toBe(0);
	});
});
