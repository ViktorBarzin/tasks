import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from './db';
import { _resetReplicaForTests, foldServerState, loadReplica, recordOp, replica } from './replica';
import {
	_resetSyncForTests,
	deadOps,
	drainOpQueue,
	needsLogin,
	needsReconnect,
	online,
	pendingOps,
	syncNow,
	syncStuck
} from './sync';
import type { Op, OpResult, SyncPayload, Task, TaskList } from './types';

function list(id: string, name = id, order: number | null = null): TaskList {
	return { id, name, order, deleted: false };
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
		title: `task ${uid}`,
		notes: '',
		due: null,
		due_has_time: false,
		priority: 0
	};
}

function ok(results: OpResult[]): Response {
	return new Response(JSON.stringify({ results }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function syncBody(payload: SyncPayload): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

/** A response as it appears with redirect:'manual' after the Authentik bounce. */
function opaqueRedirect(): Response {
	return {
		type: 'opaqueredirect',
		ok: false,
		status: 0,
		headers: new Headers(),
		json: async () => ({})
	} as unknown as Response;
}

/** Applied-status results for every op in a posted batch. */
function allApplied(body: string): OpResult[] {
	const { ops } = JSON.parse(body) as { ops: Op[] };
	return ops.map((o) => ({ op_id: o.op_id, status: 'applied', error: null }));
}

const EMPTY_SYNC: SyncPayload = { cursor: 'cur-1', full: true, lists: [], tasks: [] };

/** Let a whole async cycle (chained IDB setImmediates + fetch microtasks) settle. */
async function flushEventLoop(turns = 25): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	db._resetForTests();
	_resetReplicaForTests();
	_resetSyncForTests();
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('drainOpQueue', () => {
	it('posts queued ops in order and removes acked ones', async () => {
		await db.enqueueOp(createOp('a'));
		await db.enqueueOp(createOp('b'));
		fetchMock.mockImplementation(async (_url, init: RequestInit) =>
			ok(allApplied(init.body as string))
		);

		const outcome = await drainOpQueue();

		expect(outcome).toBe('drained');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { ops: Op[] };
		expect(sent.ops.map((o) => o.op_id)).toEqual(['op-a', 'op-b']);
		expect(await db.opCount()).toBe(0);
	});

	it('drains large queues in ordered batches', async () => {
		for (let i = 0; i < 30; i++) await db.enqueueOp(createOp(String(i).padStart(2, '0')));
		fetchMock.mockImplementation(async (_url, init: RequestInit) =>
			ok(allApplied(init.body as string))
		);

		await drainOpQueue();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { ops: Op[] };
		const second = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as { ops: Op[] };
		expect(first.ops).toHaveLength(25);
		expect(second.ops).toHaveLength(5);
		expect(first.ops[0]!.op_id).toBe('op-00');
		expect(second.ops[0]!.op_id).toBe('op-25');
		expect(await db.opCount()).toBe(0);
	});

	it('treats "duplicate" as success (idempotent replay handshake)', async () => {
		await db.enqueueOp(createOp('a'));
		fetchMock.mockImplementation(async () =>
			ok([{ op_id: 'op-a', status: 'duplicate', error: null }])
		);

		const outcome = await drainOpQueue();

		expect(outcome).toBe('drained');
		expect(await db.opCount()).toBe(0);
	});

	it('treats "lww_reapplied" as success', async () => {
		await db.enqueueOp(createOp('a'));
		fetchMock.mockImplementation(async () =>
			ok([{ op_id: 'op-a', status: 'lww_reapplied', error: null }])
		);

		expect(await drainOpQueue()).toBe('drained');
		expect(await db.opCount()).toBe(0);
	});

	it('keeps a `retry` op queued (bumped attempts) and reports blocked (§B)', async () => {
		await db.enqueueOp(createOp('a'));
		fetchMock.mockImplementation(async () =>
			ok([{ op_id: 'op-a', status: 'retry', error: 'nextcloud 503' }])
		);

		const outcome = await drainOpQueue();

		expect(outcome).toBe('blocked');
		expect(await db.opCount()).toBe(1);
		const [q] = await db.peekOps(1);
		expect(q!.attempts).toBe(1);
		expect(await db.deadOpCount()).toBe(0); // a retry is never dead-lettered
	});

	it('never drops a `retry` op, and flags stuck after many cycles (§B)', async () => {
		await db.enqueueOp(createOp('a'));
		fetchMock.mockImplementation(async () =>
			ok([{ op_id: 'op-a', status: 'retry', error: 'still 503' }])
		);

		for (let i = 0; i < 8; i++) expect(await drainOpQueue()).toBe('blocked');

		// Retryable ops are never dropped — still queued, never dead-lettered.
		expect(await db.opCount()).toBe(1);
		expect(await db.deadOpCount()).toBe(0);
		expect(get(syncStuck)).toBe(true);
	});

	it('acks the prefix, keeps the `retry` op + everything after it in order (§B)', async () => {
		await db.enqueueOp(createOp('a'));
		await db.enqueueOp(createOp('b'));
		await db.enqueueOp(createOp('c'));
		// Server applied a, hit a transient failure on b, and stopped — c omitted.
		fetchMock.mockImplementation(async () =>
			ok([
				{ op_id: 'op-a', status: 'applied', error: null },
				{ op_id: 'op-b', status: 'retry', error: '503' }
			])
		);

		const outcome = await drainOpQueue();

		expect(outcome).toBe('blocked');
		const remaining = await db.peekOps(10);
		expect(remaining.map((q) => q.op.op_id)).toEqual(['op-b', 'op-c']);
	});

	it('dead-letters a permanent `error`, dequeues it, and keeps draining (§B)', async () => {
		await db.enqueueOp(createOp('a'));
		await db.enqueueOp(createOp('b'));
		fetchMock.mockImplementation(async () =>
			ok([
				{ op_id: 'op-a', status: 'error', error: 'unknown kind' },
				{ op_id: 'op-b', status: 'applied', error: null }
			])
		);

		const outcome = await drainOpQueue();

		expect(outcome).toBe('drained');
		expect(await db.opCount()).toBe(0); // both left the live queue
		expect(await db.deadOpCount()).toBe(1); // the errored op parked, not dropped
		expect(get(deadOps)).toBe(1);
	});

	it('leaves the queue untouched when the POST itself fails', async () => {
		await db.enqueueOp(createOp('a'));
		fetchMock.mockImplementation(async () => {
			throw new TypeError('network down');
		});

		await expect(drainOpQueue()).rejects.toThrow();
		expect(await db.opCount()).toBe(1);
	});
});

describe('foldServerState', () => {
	it('folds a full snapshot into store and IndexedDB', async () => {
		await foldServerState({
			cursor: 'c1',
			full: true,
			lists: [list('l1', 'Personal')],
			tasks: [task('a')]
		});

		const state = get(replica);
		expect(state.lists.get('l1')?.name).toBe('Personal');
		expect(state.tasks.get('a')?.title).toBe('task a');
		expect(await db.getCursor()).toBe('c1');
	});

	it('folds deltas: upsert + tombstone', async () => {
		await foldServerState({
			cursor: 'c1',
			full: true,
			lists: [list('l1')],
			tasks: [task('a'), task('b')]
		});
		await foldServerState({
			cursor: 'c2',
			full: false,
			lists: [],
			tasks: [task('a', 'l1', { title: 'renamed' }), task('b', 'l1', { deleted: true })]
		});

		const state = get(replica);
		expect(state.tasks.get('a')?.title).toBe('renamed');
		expect(state.tasks.has('b')).toBe(false);
		expect(await db.getCursor()).toBe('c2');
	});

	it('folds a server-side order change into the Replica (contract v1.2)', async () => {
		await foldServerState({
			cursor: 'c1',
			full: true,
			lists: [list('l1', 'Personal'), list('l2', 'Work', 0)],
			tasks: []
		});
		expect(get(replica).lists.get('l1')?.order).toBeNull();
		expect(get(replica).lists.get('l2')?.order).toBe(0);

		// Another device reordered: the delta re-ships the Lists with new orders.
		await foldServerState({
			cursor: 'c2',
			full: false,
			lists: [list('l1', 'Personal', 0), list('l2', 'Work', 1)],
			tasks: []
		});
		const state = get(replica);
		expect(state.lists.get('l1')?.order).toBe(0);
		expect(state.lists.get('l2')?.order).toBe(1);
		// Durably too (restart-safe).
		const onDisk = await db.readReplica();
		expect(onDisk.lists.get('l1')?.order).toBe(0);
	});

	it('rebases still-queued local ops on top of a full snapshot', async () => {
		await recordOp(createOp('local'));
		await foldServerState({
			cursor: 'c1',
			full: true,
			lists: [list('l1')],
			tasks: [task('server')]
		});

		const state = get(replica);
		expect(state.tasks.has('server')).toBe(true);
		// The unpushed local create survives the full replace…
		expect(state.tasks.has('local')).toBe(true);
		// …including durably (restart-safe).
		const onDisk = await db.readReplica();
		expect(onDisk.tasks.has('local')).toBe(true);
	});
});

describe('loadReplica (cold launch)', () => {
	it('replays a queued op whose effect never persisted — mid-write kill (§J)', async () => {
		// A snapshot on disk…
		await db.applySyncPayload({
			cursor: 'c1',
			full: true,
			lists: [list('l1')],
			tasks: [task('a', 'l1', { title: 'original' })]
		});
		// …plus a queued edit that crashed before its optimistic Replica write
		// (recordOp enqueues durably first, then applies).
		await db.enqueueOp({ op_id: 'op-e', kind: 'task_update', uid: 'a', title: 'edited offline' });

		await loadReplica();

		// The edit is visible offline even though it never hit IndexedDB's task row.
		expect(get(replica).tasks.get('a')?.title).toBe('edited offline');
	});
});

describe('syncNow (full cycle)', () => {
	it('drains the queue, then GETs /api/sync with the stored cursor and folds', async () => {
		await db.setMeta('cursor', 'prev-cursor');
		await db.enqueueOp(createOp('a'));
		const calls: string[] = [];
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			calls.push(url);
			if (url.startsWith('/api/ops')) return ok(allApplied(init!.body as string));
			return syncBody({
				cursor: 'next-cursor',
				full: false,
				lists: [],
				tasks: [task('a')]
			});
		});

		await syncNow();

		expect(calls[0]).toBe('/api/ops');
		expect(calls[1]).toBe(`/api/sync?cursor=${encodeURIComponent('prev-cursor')}`);
		expect(await db.getCursor()).toBe('next-cursor');
		expect(get(replica).tasks.has('a')).toBe(true);
		expect(get(pendingOps)).toBe(0);
		expect(get(online)).toBe(true);
	});

	it('skips the sync GET while the queue is blocked', async () => {
		await db.enqueueOp(createOp('a'));
		fetchMock.mockImplementation(async () =>
			ok([{ op_id: 'op-a', status: 'retry', error: 'nope' }])
		);

		await syncNow();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(get(pendingOps)).toBe(1);
	});

	it('flags offline and retries with exponential backoff on network failure', async () => {
		// Only fake setTimeout: fake-indexeddb relies on real setImmediate.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		fetchMock.mockImplementation(async () => {
			throw new TypeError('offline');
		});

		await syncNow();
		expect(get(online)).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1000); // 1st retry after 1s
		await flushEventLoop();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(2000); // 2nd retry after a doubled 2s
		await flushEventLoop();
		expect(fetchMock).toHaveBeenCalledTimes(3);

		await vi.advanceTimersByTimeAsync(3999); // 3rd doubles again to 4s…
		await flushEventLoop();
		expect(fetchMock).toHaveBeenCalledTimes(3); // …so 3.999s is not enough
	});

	it('recovers once the network returns', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let up = false;
		fetchMock.mockImplementation(async () => {
			if (!up) throw new TypeError('offline');
			return syncBody(EMPTY_SYNC);
		});

		await syncNow();
		expect(get(online)).toBe(false);
		up = true;
		await vi.advanceTimersByTimeAsync(1000);
		await flushEventLoop();
		expect(get(online)).toBe(true);
		expect(await db.getCursor()).toBe('cur-1');
	});

	it('sets needsReconnect on a 401 (revoked Nextcloud app password)', async () => {
		fetchMock.mockImplementation(async () => new Response('unauthorized', { status: 401 }));

		await syncNow();

		expect(get(needsReconnect)).toBe(true);
		expect(get(online)).toBe(true);
	});

	it('flags needsLogin (not offline) when the API hits the Authentik wall (§I)', async () => {
		fetchMock.mockImplementation(async () => opaqueRedirect());

		await syncNow();

		expect(get(needsLogin)).toBe(true);
		expect(get(online)).toBe(true);
		expect(get(needsReconnect)).toBe(false);
	});

	it('coalesces concurrent calls into one in-flight cycle', async () => {
		fetchMock.mockImplementation(async () => syncBody(EMPTY_SYNC));

		await Promise.all([syncNow(), syncNow(), syncNow()]);

		// One initial cycle + at most one coalesced re-run.
		expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
	});
});
