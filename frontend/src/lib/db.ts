/**
 * The Replica — the complete local copy of the account's Lists and Tasks —
 * plus the Op Queue and sync cursor, all in IndexedDB (via `idb`). ADR-0001:
 * the app renders exclusively from here; the queue is ordered and durable and
 * survives restarts. This module is pure storage: no Svelte, no network.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { Op, SyncPayload, Task, TaskList } from './types';

const DB_NAME = 'tasks';
const DB_VERSION = 1;

/** An Op at rest in the queue. `seq` (autoincrement) is the replay order. */
export interface QueuedOp {
	seq?: number;
	op: Op;
	enqueuedAt: number;
	/** Times the server answered "error" for this op (drop after MAX_OP_ATTEMPTS). */
	attempts: number;
}

interface MetaRow {
	key: string;
	value: unknown;
}

interface TasksDB extends DBSchema {
	lists: { key: string; value: TaskList };
	tasks: { key: string; value: Task; indexes: { 'by-list': string } };
	meta: { key: string; value: MetaRow };
	op_queue: { key: number; value: QueuedOp };
}

let dbPromise: Promise<IDBPDatabase<TasksDB>> | null = null;

function db(): Promise<IDBPDatabase<TasksDB>> {
	if (!dbPromise) {
		dbPromise = openDB<TasksDB>(DB_NAME, DB_VERSION, {
			upgrade(database) {
				database.createObjectStore('lists', { keyPath: 'id' });
				const tasks = database.createObjectStore('tasks', { keyPath: 'uid' });
				tasks.createIndex('by-list', 'list_id');
				database.createObjectStore('meta', { keyPath: 'key' });
				database.createObjectStore('op_queue', { keyPath: 'seq', autoIncrement: true });
			}
		});
	}
	return dbPromise;
}

/** Test-only: drop the memoized connection so the next call reopens against a
 * freshly-swapped `globalThis.indexedDB`. */
export function _resetForTests(): void {
	dbPromise = null;
}

/**
 * Strip Svelte 5 `$state` proxies (not structured-cloneable) to plain JSON
 * values before an IndexedDB write. Our payloads are pure JSON, so a
 * round-trip is always safe.
 */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

// --- Replica: lists + tasks ---

export interface ReplicaSnapshot {
	lists: Map<string, TaskList>;
	tasks: Map<string, Task>;
}

/** Read the whole Replica (household scale — always small). */
export async function readReplica(): Promise<ReplicaSnapshot> {
	const database = await db();
	const [lists, tasks] = await Promise.all([
		database.getAll('lists'),
		database.getAll('tasks')
	]);
	return {
		lists: new Map(lists.map((l) => [l.id, l])),
		tasks: new Map(tasks.map((t) => [t.uid, t]))
	};
}

/**
 * Fold a Delta Sync payload into the Replica, atomically with its cursor.
 * `full: true` replaces the whole Replica; otherwise entities upsert and
 * `deleted: true` tombstones remove. Idempotent — refolding the same payload
 * is harmless, so the cursor only advances after the fold commits.
 */
export async function applySyncPayload(payload: SyncPayload): Promise<void> {
	const database = await db();
	const tx = database.transaction(['lists', 'tasks', 'meta'], 'readwrite');
	const lists = tx.objectStore('lists');
	const tasks = tx.objectStore('tasks');
	if (payload.full) {
		await lists.clear();
		await tasks.clear();
	}
	for (const l of payload.lists) {
		if (l.deleted) await lists.delete(l.id);
		else await lists.put(plain(l));
	}
	for (const t of payload.tasks) {
		if (t.deleted) await tasks.delete(t.uid);
		else await tasks.put(plain(t));
	}
	await tx.objectStore('meta').put({ key: 'cursor', value: payload.cursor });
	await tx.done;
}

export async function putList(l: TaskList): Promise<void> {
	await (await db()).put('lists', plain(l));
}

export async function putTask(t: Task): Promise<void> {
	await (await db()).put('tasks', plain(t));
}

export async function deleteTask(uid: string): Promise<void> {
	await (await db()).delete('tasks', uid);
}

/** Delete a List and everything in it (local mirror of list_delete). */
export async function deleteListCascade(listId: string): Promise<void> {
	const database = await db();
	const tx = database.transaction(['lists', 'tasks'], 'readwrite');
	await tx.objectStore('lists').delete(listId);
	const tasks = tx.objectStore('tasks');
	const uids = await tasks.index('by-list').getAllKeys(listId);
	for (const uid of uids) await tasks.delete(uid);
	await tx.done;
}

// --- Cursor + meta ---

export async function getCursor(): Promise<string> {
	return ((await getMeta<string>('cursor')) as string | undefined) ?? '';
}

export async function setMeta(key: string, value: unknown): Promise<void> {
	await (await db()).put('meta', { key, value: plain(value) });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
	const row = await (await db()).get('meta', key);
	return row?.value as T | undefined;
}

// --- Op Queue ---

export async function enqueueOp(op: Op): Promise<void> {
	await (await db()).add('op_queue', plain({ op, enqueuedAt: Date.now(), attempts: 0 }) as QueuedOp);
}

/** The oldest `limit` queued Ops, in replay (insertion) order. */
export async function peekOps(limit: number): Promise<QueuedOp[]> {
	const database = await db();
	const out: QueuedOp[] = [];
	let cursor = await database.transaction('op_queue').store.openCursor();
	while (cursor && out.length < limit) {
		out.push(cursor.value);
		cursor = await cursor.continue();
	}
	return out;
}

export async function removeOps(seqs: number[]): Promise<void> {
	if (!seqs.length) return;
	const database = await db();
	const tx = database.transaction('op_queue', 'readwrite');
	for (const seq of seqs) await tx.store.delete(seq);
	await tx.done;
}

export async function bumpAttempts(seq: number): Promise<void> {
	const database = await db();
	const tx = database.transaction('op_queue', 'readwrite');
	const row = await tx.store.get(seq);
	if (row) await tx.store.put({ ...row, attempts: row.attempts + 1 });
	await tx.done;
}

export async function opCount(): Promise<number> {
	return (await db()).count('op_queue');
}
