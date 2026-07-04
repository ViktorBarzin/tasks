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
	/**
	 * Home-screen position from the collection's Apple `calendar-order`
	 * property; `null` when unset — sort by `(order ?? MAX, name)` so
	 * unordered Lists sink below ordered ones (contract delta v1.2 §1).
	 */
	order: number | null;
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
	/**
	 * Custom-mode position from the VTODO's `X-APPLE-SORT-ORDER` (signed int);
	 * `null` when unset — the custom sort puts those last (contract delta v1.3).
	 */
	sort_order: number | null;
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
	| 'list_reorder'
	| 'list_delete';

/** Fields of a Task the client can edit (task_update carries a subset). */
export interface TaskFields {
	title: string;
	notes: string;
	due: string | null;
	due_has_time: boolean;
	priority: Priority;
	/** Custom-mode position; `task_update` with it is how a reorder travels —
	 * no dedicated op kind (contract delta v1.3 §2). `null` clears it. */
	sort_order: number | null;
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
	/** Client completion timestamp (ISO datetime) — the server's roll-forward base. */
	completed_at: string;
	/**
	 * The DUE the client currently shows (ISO date | datetime | null), so the
	 * server rolls the correct occurrence of a Recurring Task and treats an
	 * already-advanced object as a duplicate (contract-delta §C).
	 */
	occurrence_due: string | null;
}

export interface TaskUncompleteOp extends OpBase {
	kind: 'task_uncomplete';
	uid: string;
}

/**
 * A Task move between Lists. Carries BOTH endpoints (contract-delta §A):
 * `list_id` is the SOURCE List (a hint so the server locates the object in its
 * origin first — a half-done move that left a target copy can't shadow it),
 * `to_list_id` is the DESTINATION. Both are required; keep in lockstep with
 * backend schemas.py.
 */
export interface TaskMoveOp extends OpBase {
	kind: 'task_move';
	uid: string;
	list_id: string;
	to_list_id: string;
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

/**
 * Set a List's Home-screen position (contract delta v1.2 §2): the server
 * PROPPATCHes `calendar-order` on the collection. One op per List whose
 * order actually changed; idempotent (journal + same-value set is a no-op).
 */
export interface ListReorderOp extends OpBase {
	kind: 'list_reorder';
	list_id: string;
	order: number;
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
	| ListReorderOp
	| ListDeleteOp;

/**
 * Per-op replay outcome (contract-delta §B):
 *  - applied / lww_reapplied / duplicate — terminal successes (the server has it);
 *  - retry — transient upstream failure (Nextcloud 5xx / timeout); op NOT applied,
 *    safe to resend. The server stops at the first retry, so ops after it are
 *    omitted from the results and stay queued in order;
 *  - error — permanent rejection (4xx / validation / unknown kind); never
 *    succeeds as-is → the client dead-letters it.
 */
export type OpStatus = 'applied' | 'lww_reapplied' | 'duplicate' | 'retry' | 'error';

export interface OpResult {
	op_id: string;
	status: OpStatus;
	error: string | null;
}

export interface OpsResponse {
	results: OpResult[];
}
