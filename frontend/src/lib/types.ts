/**
 * THE API CONTRACT (docs/2026-07-03-tasks-pwa-design.md) — TypeScript side.
 * Both the PWA and the FastAPI backend build against exactly these shapes;
 * they mirror backend/tasks_api/schemas.py. Do not deviate.
 */

/** RFC 5545 PRIORITY, Apple mapping: 0=None, 1=High, 5=Medium, 9=Low (CONTEXT.md). */
export type Priority = 0 | 1 | 5 | 9;

/** A List — a CalDAV calendar collection holding VTODOs. */
export interface TaskList {
	id: string;
	name: string;
	deleted: boolean;
}

/** A Task — maps 1:1 to a CalDAV VTODO. */
export interface Task {
	uid: string;
	list_id: string;
	title: string;
	notes: string;
	/** ISO date (all-day) or datetime; see due_has_time. */
	due: string | null;
	due_has_time: boolean;
	priority: Priority;
	completed: boolean;
	completed_at: string | null;
	recurring: boolean;
	deleted: boolean;
}

/** GET /api/me. */
export interface Me {
	username: string;
	connected: boolean;
}

/** GET /api/sync — Delta Sync payload. Empty request cursor ⇒ full snapshot. */
export interface SyncPayload {
	/** Opaque server-side blob (base64 JSON of per-List CalDAV sync-tokens). */
	cursor: string;
	full: boolean;
	lists: TaskList[];
	tasks: Task[];
}

export type OpKind =
	| 'task_create'
	| 'task_update'
	| 'task_complete'
	| 'task_uncomplete'
	| 'task_move'
	| 'task_delete'
	| 'list_create'
	| 'list_rename'
	| 'list_delete';

/** Fields of a Task the client can edit (task_update carries a subset). */
export interface TaskFields {
	title: string;
	notes: string;
	due: string | null;
	due_has_time: boolean;
	priority: Priority;
}

interface OpBase {
	/** Client uuid — the idempotent-replay key. */
	op_id: string;
	kind: OpKind;
}

/** task_create carries the client-generated uid + the full editable fields. */
export interface TaskCreateOp extends OpBase, TaskFields {
	kind: 'task_create';
	uid: string;
	list_id: string;
}

export interface TaskUpdateOp extends OpBase, Partial<TaskFields> {
	kind: 'task_update';
	uid: string;
}

export interface TaskCompleteOp extends OpBase {
	kind: 'task_complete';
	uid: string;
	/** Client completion timestamp (ISO datetime). */
	completed_at: string;
}

export interface TaskUncompleteOp extends OpBase {
	kind: 'task_uncomplete';
	uid: string;
}

/** list_id is the destination List. */
export interface TaskMoveOp extends OpBase {
	kind: 'task_move';
	uid: string;
	list_id: string;
}

export interface TaskDeleteOp extends OpBase {
	kind: 'task_delete';
	uid: string;
}

/** list_id is client-generated so replay stays idempotent (same recipe as task uids). */
export interface ListCreateOp extends OpBase {
	kind: 'list_create';
	list_id: string;
	name: string;
}

export interface ListRenameOp extends OpBase {
	kind: 'list_rename';
	list_id: string;
	name: string;
}

export interface ListDeleteOp extends OpBase {
	kind: 'list_delete';
	list_id: string;
}

export type Op =
	| TaskCreateOp
	| TaskUpdateOp
	| TaskCompleteOp
	| TaskUncompleteOp
	| TaskMoveOp
	| TaskDeleteOp
	| ListCreateOp
	| ListRenameOp
	| ListDeleteOp;

export type OpStatus = 'applied' | 'lww_reapplied' | 'duplicate' | 'error';

export interface OpResult {
	op_id: string;
	status: OpStatus;
	error: string | null;
}

export interface OpsResponse {
	results: OpResult[];
}
