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
	uncompleteTask,
	updateTask
} from './actions';
import * as db from './db';
import { _resetReplicaForTests, replica } from './replica';
import { _resetSyncForTests } from './sync';
import type { TaskCreateOp } from './types';

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

	it('update, move, delete mutate the replica and queue ops in order', async () => {
		const a = await createList('A');
		const b = await createList('B');
		const uid = await createTask(a, { title: 'x' });

		await updateTask(uid, { title: 'renamed', due: '2026-07-09', due_has_time: false });
		await moveTask(uid, b);
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
