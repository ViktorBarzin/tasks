/**
 * User-facing mutations. Each builds an Op (client-generated uuids —
 * idempotent replay per ADR-0001), records it (durable queue + optimistic
 * Replica apply), and kicks the sync engine. The UI calls only these.
 */
import { get, writable } from 'svelte/store';

import { recordOp, replica } from './replica';
import { nextSortOrder, type TaskOrderChange } from './sort';
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

/** The Custom key a new Task in `listId` gets: bottom of the open section
 * (max concrete key + gap — contract delta v1.3 §4). */
function sortOrderForNewTask(listId: string): number {
	const inList = [...get(replica).tasks.values()].filter((t) => t.list_id === listId);
	return nextSortOrder(inList);
}

/** Create a Task; returns its client-generated uid. Unless the caller pins a
 * `sort_order`, the Task lands at the bottom of the List's open section in
 * Custom mode (a pure view — priority/due modes place it by their own keys). */
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
		priority: (fields.priority ?? 0) as Priority,
		sort_order: fields.sort_order !== undefined ? fields.sort_order : sortOrderForNewTask(listId)
	});
	kick();
	return uid;
}

export async function updateTask(uid: string, patch: Partial<TaskFields>): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'task_update', uid, ...patch });
	kick();
}

export async function completeTask(uid: string): Promise<void> {
	// occurrence_due = the DUE the row currently shows, so the server rolls the
	// right occurrence of a Recurring Task (contract-delta §C).
	const occurrenceDue = get(replica).tasks.get(uid)?.due ?? null;
	await recordOp({
		op_id: uuid(),
		kind: 'task_complete',
		uid,
		completed_at: new Date().toISOString(),
		occurrence_due: occurrenceDue
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

/** Move a Task from `fromListId` (source) to `toListId` (destination). The Op
 * carries both so the server can locate the object in its origin List first
 * (contract-delta §A). */
export async function moveTask(uid: string, toListId: string, fromListId: string): Promise<void> {
	await recordOp({
		op_id: uuid(),
		kind: 'task_move',
		uid,
		list_id: fromListId,
		to_list_id: toListId
	});
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

/**
 * Commit a Home-screen reorder: one `list_reorder` op per changed List
 * (`planListReorder` computes the minimal set), optimistic order applied
 * locally, single sync kick (contract delta v1.2 §2).
 */
export async function reorderLists(changes: { listId: string; order: number }[]): Promise<void> {
	if (!changes.length) return;
	for (const { listId, order } of changes) {
		await recordOp({ op_id: uuid(), kind: 'list_reorder', list_id: listId, order });
	}
	kick();
}

/**
 * Commit a Custom-mode task reorder: one MINIMAL `task_update` per Task whose
 * `sort_order` actually changes (`planTaskReorder` computes the set),
 * optimistic keys applied locally, single sync kick (contract delta v1.3 §4).
 */
export async function reorderTasks(changes: TaskOrderChange[]): Promise<void> {
	if (!changes.length) return;
	for (const { uid, sort_order } of changes) {
		await recordOp({ op_id: uuid(), kind: 'task_update', uid, sort_order });
	}
	kick();
}

export async function deleteList(listId: string): Promise<void> {
	await recordOp({ op_id: uuid(), kind: 'list_delete', list_id: listId });
	kick();
}
