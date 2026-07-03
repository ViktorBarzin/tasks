/**
 * The in-memory mirror of the Replica as a Svelte store, kept write-through
 * consistent with IndexedDB (lib/db.ts). Two write paths:
 *
 *  - user action → `recordOp`: durable Op Queue first, then optimistic apply
 *    (so a crash between the two still replays the Op);
 *  - sync → `foldServerState`: fold the server payload durably, then rebase
 *    any still-queued Ops on top so pending local changes never visually
 *    vanish mid-sync.
 */
import { get, writable } from 'svelte/store';

import * as db from './db';
import { applyOpToMaps, type ReplicaState } from './ops';
import type { Op, SyncPayload } from './types';

export const replica = writable<ReplicaState>({ lists: new Map(), tasks: new Map() });
export const replicaLoaded = writable(false);

/**
 * Hydrate the store from IndexedDB (app launch), then rebase still-pending Ops
 * on top. A mutation persists its Op durably BEFORE its optimistic effect
 * (recordOp), so a mid-write kill can leave a queued Op whose effect never hit
 * the Replica; replaying the queue on load surfaces those edits offline
 * (contract-delta §J).
 */
export async function loadReplica(): Promise<void> {
	await readAndRebasePending();
	replicaLoaded.set(true);
}

/** Record a user mutation: enqueue durably, then apply optimistically. */
export async function recordOp(op: Op): Promise<void> {
	await db.enqueueOp(op);
	await applyOpLocal(op);
}

async function applyOpLocal(op: Op): Promise<void> {
	const next = applyOpToMaps(get(replica), op);
	replica.set(next);
	await persistOpEffect(next, op);
}

/** Write an already-applied Op's effect through to IndexedDB. */
async function persistOpEffect(state: ReplicaState, op: Op): Promise<void> {
	switch (op.kind) {
		case 'task_create':
		case 'task_update':
		case 'task_complete':
		case 'task_uncomplete':
		case 'task_move': {
			const t = state.tasks.get(op.uid);
			if (t) await db.putTask(t);
			break;
		}
		case 'task_delete':
			await db.deleteTask(op.uid);
			break;
		case 'list_create':
		case 'list_rename': {
			const l = state.lists.get(op.list_id);
			if (l) await db.putList(l);
			break;
		}
		case 'list_delete':
			await db.deleteListCascade(op.list_id);
			break;
	}
}

/**
 * Fold a Delta Sync payload into the Replica, then rebase still-pending Ops
 * on top (in memory and back into IndexedDB — a full snapshot just cleared
 * their durable effects).
 */
export async function foldServerState(payload: SyncPayload): Promise<void> {
	await db.applySyncPayload(payload);
	await readAndRebasePending();
}

/**
 * Read the durable Replica, replay every still-queued Op on top (in order) so
 * unpushed local changes never visually vanish, publish the store, and
 * re-persist those Op effects (a full snapshot just cleared them). Shared by
 * cold launch (loadReplica) and post-fold rebase.
 */
async function readAndRebasePending(): Promise<void> {
	let state: ReplicaState = await db.readReplica();
	const pending = await db.peekOps(Number.MAX_SAFE_INTEGER);
	for (const q of pending) state = applyOpToMaps(state, q.op);
	replica.set(state);
	for (const q of pending) await persistOpEffect(state, q.op);
}

export function _resetReplicaForTests(): void {
	replica.set({ lists: new Map(), tasks: new Map() });
	replicaLoaded.set(false);
}
