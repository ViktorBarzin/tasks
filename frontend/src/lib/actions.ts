/**
 * User-facing mutations. Each builds an Op (client-generated uuids —
 * idempotent replay per ADR-0001), records it (durable queue + optimistic
 * Replica apply), and kicks the sync engine. The UI calls only these.
 */
import { writable } from 'svelte/store';

import { recordOp } from './replica';
import { syncNow } from './sync';
import type { Priority, TaskFields } from './types';

/** How long a completed Task stays visible in open-only views (ms). */
export const COMPLETE_GRACE_MS = 1800;

/** Uids completed moments ago — views keep them visible for the strike animation. */
export const recentlyCompleted = writable<Set<string>>(new Set());

function uuid(): string {
	return crypto.randomUUID();
}

function kick(): void {
	void syncNow();
}

export interface NewTaskFields extends Partial<TaskFields> {
	title: string;
}

/** Create a Task; returns its client-generated uid. */
export async function createTask(listId: string, fields: NewTaskFields): Promise<string> {
	const uid = uuid();
	await recordOp({
		op_id: uuid(),
		kind: 'task_create',
		uid,
		list_id: listId,
		title: fields.title,
		notes: fields.notes ?? '',
		due: fields.due ?? null,
		due_has_time: fields.due_has_time ?? false,
		priority: (fields.priority ?? 0) as Priority
	});
	kick();
	return uid;
}

export async function updateTask(uid: string, patch: Partial<TaskFields>): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'task_update', uid, ...patch });
	kick();
}

export async function completeTask(uid: string): Promise<void> {
	await recordOp({
		op_id: uuid(),
		kind: 'task_complete',
		uid,
		completed_at: new Date().toISOString()
	});
	recentlyCompleted.update((s) => new Set(s).add(uid));
	setTimeout(() => {
		recentlyCompleted.update((s) => {
			const next = new Set(s);
			next.delete(uid);
			return next;
		});
	}, COMPLETE_GRACE_MS);
	kick();
}

export async function uncompleteTask(uid: string): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'task_uncomplete', uid });
	recentlyCompleted.update((s) => {
		const next = new Set(s);
		next.delete(uid);
		return next;
	});
	kick();
}

export async function moveTask(uid: string, listId: string): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'task_move', uid, list_id: listId });
	kick();
}

export async function deleteTask(uid: string): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'task_delete', uid });
	kick();
}

/** Create a List; returns its client-generated id (idempotent replay). */
export async function createList(name: string): Promise<string> {
	const listId = uuid();
	await recordOp({ op_id: uuid(), kind: 'list_create', list_id: listId, name });
	kick();
	return listId;
}

export async function renameList(listId: string, name: string): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'list_rename', list_id: listId, name });
	kick();
}

export async function deleteList(listId: string): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'list_delete', list_id: listId });
	kick();
}
