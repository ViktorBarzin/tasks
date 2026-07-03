import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import * as db from './db';
import type { Op, SyncPayload, Task, TaskList } from './types';

function list(id: string, name = id, deleted = false, order: number | null = null): TaskList {
	return { id, name, order, deleted };
}

function task(uid: string, list_id = 'l1', extra: Partial<Task> = {}): Task {
	return {
		uid,
		list_id,
		title: `task ${uid}`,
		notes: '',
		due: null,
		due_has_time: false,
		priority: 0,
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: false,
		...extra
	};
}

function createOp(uid: string): Op {
	return {
		op_id: `op-${uid}`,
		kind: 'task_create',
		uid,
		list_id: 'l1',
		title: 't',
		notes: '',
		due: null,
		due_has_time: false,
		priority: 0
	};
}

beforeEach(() => {
	// Fresh in-memory IndexedDB per test, and a fresh memoized connection.
	globalThis.indexedDB = new IDBFactory();
	db._resetForTests();
});

describe('replica storage', () => {
	it('applies a full snapshot, replacing prior contents', async () => {
		await db.applySyncPayload({
			cursor: 'c1',
			full: true,
			lists: [list('l1'), list('l2')],
			tasks: [task('a'), task('b', 'l2')]
		});
		await db.applySyncPayload({
			cursor: 'c2',
			full: true,
			lists: [list('l2', 'Renamed')],
			tasks: [task('b', 'l2')]
		});

		const replica = await db.readReplica();
		expect([...replica.lists.keys()]).toEqual(['l2']);
		expect(replica.lists.get('l2')?.name).toBe('Renamed');
		expect([...replica.tasks.keys()]).toEqual(['b']);
		expect(await db.getCursor()).toBe('c2');
	});

	it('folds a delta: upserts live entities, removes tombstones', async () => {
		await db.applySyncPayload({
			cursor: 'c1',
			full: true,
			lists: [list('l1')],
			tasks: [task('a'), task('gone')]
		});
		const delta: SyncPayload = {
			cursor: 'c2',
			full: false,
			lists: [list('l2', 'New')],
			tasks: [
				task('a', 'l1', { title: 'edited' }),
				task('gone', 'l1', { deleted: true }),
				task('fresh', 'l2')
			]
		};
		await db.applySyncPayload(delta);

		const replica = await db.readReplica();
		expect(replica.tasks.get('a')?.title).toBe('edited');
		expect(replica.tasks.has('gone')).toBe(false);
		expect(replica.tasks.get('fresh')?.list_id).toBe('l2');
		expect(replica.lists.get('l2')?.name).toBe('New');
		expect(replica.lists.has('l1')).toBe(true);
		expect(await db.getCursor()).toBe('c2');
	});

	it('a full snapshot drops deleted entities instead of storing them', async () => {
		await db.applySyncPayload({
			cursor: 'c1',
			full: true,
			lists: [list('l1'), list('dead', 'dead', true)],
			tasks: [task('a', 'l1', { deleted: true })]
		});
		const replica = await db.readReplica();
		expect(replica.lists.has('dead')).toBe(false);
		expect(replica.tasks.size).toBe(0);
	});

	it('a delta List tombstone cascades to that list’s tasks (§E)', async () => {
		await db.applySyncPayload({
			cursor: 'c1',
			full: true,
			lists: [list('l1'), list('l2')],
			tasks: [task('a', 'l1'), task('b', 'l1'), task('c', 'l2')]
		});
		await db.applySyncPayload({
			cursor: 'c2',
			full: false,
			lists: [list('l1', 'l1', true)], // tombstone
			tasks: []
		});
		const replica = await db.readReplica();
		expect(replica.lists.has('l1')).toBe(false);
		expect(replica.tasks.has('a')).toBe(false);
		expect(replica.tasks.has('b')).toBe(false);
		expect(replica.tasks.has('c')).toBe(true); // other list untouched
	});

	it('deleting a list locally cascades to its tasks', async () => {
		await db.applySyncPayload({
			cursor: 'c1',
			full: true,
			lists: [list('l1'), list('l2')],
			tasks: [task('a', 'l1'), task('b', 'l2')]
		});
		await db.deleteListCascade('l1');
		const replica = await db.readReplica();
		expect(replica.lists.has('l1')).toBe(false);
		expect(replica.tasks.has('a')).toBe(false);
		expect(replica.tasks.has('b')).toBe(true);
	});
});

describe('op queue', () => {
	it('is ordered and durable: enqueue → peek returns FIFO', async () => {
		await db.enqueueOp(createOp('a'));
		await db.enqueueOp(createOp('b'));
		await db.enqueueOp(createOp('c'));

		const ops = await db.peekOps(10);
		expect(ops.map((q) => q.op.op_id)).toEqual(['op-a', 'op-b', 'op-c']);
		expect(await db.opCount()).toBe(3);
	});

	it('peek respects the batch limit', async () => {
		await db.enqueueOp(createOp('a'));
		await db.enqueueOp(createOp('b'));
		expect((await db.peekOps(1)).map((q) => q.op.op_id)).toEqual(['op-a']);
	});

	it('removeOps removes exactly the acked entries', async () => {
		await db.enqueueOp(createOp('a'));
		await db.enqueueOp(createOp('b'));
		const [first] = await db.peekOps(1);
		await db.removeOps([first!.seq!]);
		const rest = await db.peekOps(10);
		expect(rest.map((q) => q.op.op_id)).toEqual(['op-b']);
	});

	it('bumpAttempts persists the retry count', async () => {
		await db.enqueueOp(createOp('a'));
		const [q] = await db.peekOps(1);
		await db.bumpAttempts(q!.seq!);
		await db.bumpAttempts(q!.seq!);
		const [again] = await db.peekOps(1);
		expect(again!.attempts).toBe(2);
	});
});

describe('dead-letter store (§B)', () => {
	it('parks permanently-failed ops out of the live queue and counts them', async () => {
		expect(await db.deadOpCount()).toBe(0);
		await db.deadLetterOp(createOp('x'), 'unknown kind');
		await db.deadLetterOp(createOp('y'), null);
		expect(await db.deadOpCount()).toBe(2);
		expect(await db.opCount()).toBe(0); // dead-lettering doesn't touch the live queue
	});
});

describe('meta', () => {
	it('stores and reads arbitrary keys', async () => {
		expect(await db.getMeta('connected')).toBeUndefined();
		await db.setMeta('connected', true);
		expect(await db.getMeta('connected')).toBe(true);
	});
});
