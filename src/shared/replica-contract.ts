/**
 * The frozen IndexedDB contract (ADR-0001, Pilot / Client continuity).
 *
 * The React build inherits the Svelte build's origin, service worker and
 * IndexedDB, including ops queued offline by the old build. These values are
 * copied from frontend/src/lib/db.ts and must not change: a different name,
 * version or store layout would orphan or corrupt those queued ops.
 */
import type { Op, Task, TaskList } from "./contract";

export const REPLICA_DB_NAME = "tasks";
export const REPLICA_DB_VERSION = 2;

/**
 * Stores and their keys, as `upgrade()` in frontend/src/lib/db.ts creates them:
 * - version 1: `lists` (keyPath `id`), `tasks` (keyPath `uid`, index
 *   `by-list` on `list_id`), `meta` (keyPath `key`), `op_queue` (keyPath
 *   `seq`, autoIncrement);
 * - version 2: `dead_ops` (keyPath `seq`, autoIncrement).
 */
export const REPLICA_STORES = {
	lists: { keyPath: "id" },
	tasks: { keyPath: "uid", indexes: { "by-list": "list_id" } },
	meta: { keyPath: "key" },
	op_queue: { keyPath: "seq", autoIncrement: true },
	dead_ops: { keyPath: "seq", autoIncrement: true },
} as const;

/** The `meta` row holding the sync cursor. */
export const META_CURSOR_KEY = "cursor";

/** An op at rest in `op_queue`. `seq` is the replay order. */
export interface QueuedOp {
	seq?: number;
	op: Op;
	enqueuedAt: number;
	/** Times the server answered "retry". Retryable ops are never dropped. */
	attempts: number;
}

/** An op the server permanently rejected, parked in `dead_ops`. */
export interface DeadOp {
	seq?: number;
	op: Op;
	error: string | null;
	failedAt: number;
}

export interface MetaRow {
	key: string;
	value: unknown;
}

export type ReplicaList = TaskList;
export type ReplicaTask = Task;
