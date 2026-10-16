/**
 * THE API CONTRACT, TypeScript side of the port.
 *
 * Mirrors backend/tasks_api/schemas.py and frontend/src/lib/types.ts, plus the
 * contract deltas in docs/ (v1.1 to v1.4). Installed PWAs keep running the old
 * Svelte build against this server until they update, and queued offline ops
 * replay against it, so every shape here is byte-compatible with the FastAPI
 * backend. Change it only together with a contract-delta doc.
 *
 * Byte-compatibility notes for builders:
 * - Interfaces list fields in wire order. FastAPI (Pydantic) serialises in
 *   declaration order with no whitespace, so build response objects with keys
 *   in this order; `JSON.stringify` then produces the same bytes.
 * - Optional-on-the-wire does not exist in responses: Python always emits
 *   every field, with `null` where the type allows it (never omits the key).
 * - Python's `datetime.isoformat()` produces strings such as
 *   `2026-07-03T10:00:00+00:00` (offset, not `Z`), `2026-07-03T10:00:00`
 *   (floating) and `2026-07-03` (all-day). See src/server/caldav/ics.server.ts.
 *
 * This file is shared by the browser and the server, so it must not import
 * anything server-only.
 */
import { z } from "zod";

// ---------------------------------------------------------------- primitives

/** RFC 5545 PRIORITY, Apple mapping: 0=None, 1=High, 5=Medium, 9=Low (CONTEXT.md). */
export type Priority = 0 | 1 | 5 | 9;
export const PRIORITIES = [0, 1, 5, 9] as const satisfies readonly Priority[];

/** The three shared per-List sort modes (contract delta v1.4). */
export type SortMode = "custom" | "priority" | "due";
export const SORT_MODES = [
	"custom",
	"priority",
	"due",
] as const satisfies readonly SortMode[];

export const OP_KINDS = [
	"task_create",
	"task_update",
	"task_complete",
	"task_uncomplete",
	"task_move",
	"task_delete",
	"list_create",
	"list_rename",
	"list_reorder",
	"list_set_sort_mode",
	"list_delete",
] as const;
export type OpKind = (typeof OP_KINDS)[number];

/**
 * Per-op outcome (contract delta v1.1 §B):
 * - applied / lww_reapplied / duplicate: terminal successes;
 * - retry: transient upstream failure (Nextcloud 5xx or timeout), NOT applied,
 *   safe to resend. The server stops the batch at the first retry; later ops
 *   are omitted from `results` and stay queued in order;
 * - error: permanent (4xx, validation, unknown kind); the client dead-letters it.
 */
export const OP_STATUSES = [
	"applied",
	"lww_reapplied",
	"duplicate",
	"retry",
	"error",
] as const;
export type OpStatus = (typeof OP_STATUSES)[number];

/** Task fields an op may set via task_create / task_update (ics_mapper.MUTABLE_FIELDS). */
export const MUTABLE_TASK_FIELDS = [
	"title",
	"notes",
	"due",
	"due_has_time",
	"priority",
	"sort_order",
] as const;
export type MutableTaskField = (typeof MUTABLE_TASK_FIELDS)[number];

// ---------------------------------------------------------------- resources

/** A List: a CalDAV calendar collection holding VTODOs. */
export interface TaskList {
	id: string;
	name: string;
	/** Apple `calendar-order`; null when unset (contract delta v1.2 §1). */
	order: number | null;
	/** `{urn:viktorbarzin:tasks}sort-mode`; null when unset or unrecognised (v1.4 §1). */
	sort_mode: SortMode | null;
	deleted: boolean;
}

/** A Task: maps 1:1 to a CalDAV VTODO. */
export interface Task {
	uid: string;
	list_id: string;
	title: string;
	notes: string;
	/** ISO date (all-day) or datetime; see due_has_time. */
	due: string | null;
	due_has_time: boolean;
	priority: Priority;
	/** `X-APPLE-SORT-ORDER` (signed int); null when unset (contract delta v1.3). */
	sort_order: number | null;
	completed: boolean;
	completed_at: string | null;
	recurring: boolean;
	deleted: boolean;
}

// ---------------------------------------------------------------- GET /api/me

/** GET /api/me: 200. */
export interface MeResponse {
	username: string;
	connected: boolean;
}

// ---------------------------------------------------------------- POST /api/onboard

/**
 * POST /api/onboard. 204 with an empty body after a live CalDAV check;
 * 401 `invalid_credentials` when Nextcloud rejects the app password.
 * Re-onboarding rotates the stored credential in place.
 */
export interface OnboardRequest {
	nc_username: string;
	app_password: string;
}

export const onboardRequestSchema = z.object({
	nc_username: z.string(),
	app_password: z.string(),
});

// ---------------------------------------------------------------- GET /api/sync

/**
 * GET /api/sync?cursor=<opaque>. An empty or undecodable cursor means a full
 * snapshot (`full: true`). The cursor is opaque to clients: base64url JSON of
 * per-List CalDAV sync-tokens (src/server/sync/cursor.server.ts).
 */
export interface SyncResponse {
	cursor: string;
	full: boolean;
	lists: TaskList[];
	tasks: Task[];
}

/** Query string of GET /api/sync. A missing `cursor` is the empty string. */
export const syncQuerySchema = z.object({
	cursor: z.string().default(""),
});

// ---------------------------------------------------------------- POST /api/ops

/** Fields of a Task the client can edit (task_update carries a subset). */
export interface TaskFields {
	title: string;
	notes: string;
	due: string | null;
	due_has_time: boolean;
	priority: Priority;
	/** null clears it; a task_update with it is how a reorder travels (v1.3 §2). */
	sort_order: number | null;
}

interface OpBase {
	/** Client uuid: the idempotent-replay key. */
	op_id: string;
	kind: OpKind;
}

/** task_create carries the client-generated uid and the full editable fields. */
export interface TaskCreateOp extends OpBase, TaskFields {
	kind: "task_create";
	uid: string;
	list_id: string;
}

/** `list_id` is an optional locator hint. */
export interface TaskUpdateOp extends OpBase, Partial<TaskFields> {
	kind: "task_update";
	uid: string;
	list_id?: string;
}

export interface TaskCompleteOp extends OpBase {
	kind: "task_complete";
	uid: string;
	/** Client completion instant (ISO datetime): the roll-forward base (v1.1 §C). */
	completed_at: string;
	/** The DUE the client saw (ISO date | datetime | null); guards a double roll (§C). */
	occurrence_due: string | null;
}

export interface TaskUncompleteOp extends OpBase {
	kind: "task_uncomplete";
	uid: string;
}

/** `list_id` is the SOURCE hint and `to_list_id` the DESTINATION (v1.1 §A). */
export interface TaskMoveOp extends OpBase {
	kind: "task_move";
	uid: string;
	list_id: string;
	to_list_id: string;
}

export interface TaskDeleteOp extends OpBase {
	kind: "task_delete";
	uid: string;
}

/** `list_id` is client-generated and URL-safe: `^[A-Za-z0-9][A-Za-z0-9_.-]*$`. */
export interface ListCreateOp extends OpBase {
	kind: "list_create";
	list_id: string;
	name: string;
}

export interface ListRenameOp extends OpBase {
	kind: "list_rename";
	list_id: string;
	name: string;
}

/** PROPPATCH `calendar-order` (v1.2 §2). */
export interface ListReorderOp extends OpBase {
	kind: "list_reorder";
	list_id: string;
	order: number;
}

/** PROPPATCH the `sort-mode` dead property (v1.4 §2). */
export interface ListSetSortModeOp extends OpBase {
	kind: "list_set_sort_mode";
	list_id: string;
	sort_mode: SortMode;
}

export interface ListDeleteOp extends OpBase {
	kind: "list_delete";
	list_id: string;
}

/** What a well-behaved client sends. */
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
	| ListSetSortModeOp
	| ListDeleteOp;

/**
 * What the server ACCEPTS for one op, mirroring Pydantic's `Op` model:
 * `op_id` and `kind` are required strings (any kind; an unknown kind becomes a
 * per-op `error`, never a whole-batch 422), `uid` / `list_id` / `to_list_id`
 * are optional strings or null, and every other key passes through as an extra
 * that the per-kind handler validates itself.
 */
export const wireOpSchema = z.looseObject({
	op_id: z.string(),
	kind: z.string(),
	uid: z.string().nullish(),
	list_id: z.string().nullish(),
	to_list_id: z.string().nullish(),
});
export type WireOp = z.infer<typeof wireOpSchema>;

/** POST /api/ops request body. A body that fails this is a 422 `validation_error`. */
export const opsRequestSchema = z.object({
	ops: z.array(wireOpSchema),
});
export interface OpsRequest {
	ops: Op[];
}

export interface OpResult {
	op_id: string;
	status: OpStatus;
	error: string | null;
}

/** POST /api/ops: 200, one result per processed op, in order (see OpStatus). */
export interface OpsResponse {
	results: OpResult[];
}

// ---------------------------------------------------------------- errors

/**
 * Every non-2xx /api response is `{"error": {"code", "message"}}`
 * (backend/tasks_api/errors.py). Clients branch on `code`.
 */
export interface ErrorEnvelope {
	error: { code: string; message: string };
}

/** Codes the Python backend emits today, with their HTTP status. */
export const ERROR_CODES = {
	/** 401: no identity on an /api request. */
	unauthorized: 401,
	/** 401 from POST /api/onboard: Nextcloud rejected the submitted app password. */
	invalid_credentials: 401,
	/** 401: Nextcloud rejected the STORED app password; the client shows "reconnect". */
	nextcloud_unauthorized: 401,
	/** 409: no Connected Account yet; the client runs onboarding. */
	not_connected: 409,
	/** 422: request body or query failed validation. Never echoes the input (v1.1 §G). */
	validation_error: 422,
	/** 500: TASKS_FERNET_KEY missing. */
	server_misconfigured: 500,
	/** 500: anything unexpected. */
	internal_error: 500,
	bad_request: 400,
	not_found: 404,
	conflict: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

// ---------------------------------------------------------------- GET /api/signin

/**
 * GET /api/signin returns a tiny self-closing HTML page with
 * `cache-control: no-store` (tasks ADR-0004). Reaching it proves a session.
 */
export const SIGNIN_PATH = "/api/signin";

// ---------------------------------------------------------------- realtime (new)

/**
 * GET /api/events: Server-Sent Events, new in the TypeScript build (ADR-0001,
 * Pilot / Realtime). Not part of the frozen contract: old Svelte builds never
 * open it. Event names are the SSE `event:` field; data is JSON.
 *
 * - `poke`: an op batch for this user was applied; run a delta sync.
 * - `resync`: the server's LISTEN connection reconnected and events may have
 *   been lost; run a delta sync.
 * After any SSE reconnect the client also runs a delta sync on its own.
 * Heartbeats are SSE comment lines (`: ping`) every 25 seconds.
 */
export const EVENTS_PATH = "/api/events";

export type RealtimeEvent =
	| {
			type: "poke";
			/** Optional `X-Tasks-Client-Id` of the device that sent the ops. */
			source_client_id: string | null;
	  }
	| { type: "resync" };

/** Optional request header a client may send so it can ignore its own pokes. */
export const CLIENT_ID_HEADER = "X-Tasks-Client-Id";
