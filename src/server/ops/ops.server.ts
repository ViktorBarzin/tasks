/**
 * POST /api/ops: replay a batch of client ops against Nextcloud.
 * Port of backend/tasks_api/routers/ops.py.
 *
 * Guarantees, per the contract (docs/2026-07-03-review-fixes-contract-delta.md):
 * - in order: ops apply sequentially, one result each;
 * - idempotent: an op_id already in applied_ops, or an existing create UID
 *   (`If-None-Match: *`), returns `duplicate`, never a double apply;
 * - Silent LWW: a 412 on a stale ETag refetches, re-applies the op's own
 *   fields and PUTs again (up to 3 attempts), reported as `lww_reapplied`;
 * - an unknown kind is a per-op `error`, never a whole-batch 422;
 * - CalDAVTransient stops the batch: that op is `retry`, later ops are omitted;
 * - CalDAVUnauthorized aborts the batch with the 401 `nextcloud_unauthorized`
 *   envelope (rethrow it);
 * - each applied op is journaled in applied_ops (authentik_username = the
 *   account key); a unique-violation on insert means another request journaled
 *   it first, and the result is `duplicate`.
 * After a batch that applied at least one op, poke the user's other devices
 * (src/server/realtime/notify.server.ts).
 */
import {
	MUTABLE_TASK_FIELDS,
	OP_KINDS,
	type OpKind,
	type OpResult,
	type OpStatus,
	type OpsResponse,
	SORT_MODES,
	type SortMode,
	type WireOp,
} from "#/shared/contract";
import {
	CalDAVAlreadyExists,
	type CalDAVEngine,
	CalDAVError,
	CalDAVNotFound,
	CalDAVPreconditionFailed,
	CalDAVTransient,
	CalDAVUnauthorized,
	type ListInfo,
	type ObjectState,
} from "../caldav/engine.server";
import * as ics from "../caldav/ics.server";
import { MapperError, type OpTaskFields } from "../caldav/ics.server";
import { RecurrenceError } from "../caldav/recurrence.server";
import { getLogger } from "../logging.server";
import { opsAppliedTotal } from "../metrics.server";
import { pokeUser } from "../realtime/notify.server";
import type { OpJournal } from "./journal.server";
import {
	IsoFormatError,
	parsePythonIsoDatetime,
	pyRepr,
} from "./python-compat.server";

const log = getLogger("tasks.ops");

/** Valid `list_create` ids: client-generated and URL-safe. */
export const LIST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const MAX_ETAG_RETRIES = 3;

const VALID_KINDS: ReadonlySet<string> = new Set(OP_KINDS);
const VALID_SORT_MODES: ReadonlySet<string> = new Set(SORT_MODES);
/** Python's `sorted(_VALID_SORT_MODES)` as it appears in error strings. */
const SORT_MODES_REPR = pyRepr([...SORT_MODES].sort());

/** The engine methods ops use; tests pass the fake Nextcloud's engine. */
export type OpsEngine = Pick<
	CalDAVEngine,
	| "objectPath"
	| "listTaskLists"
	| "findTask"
	| "getObject"
	| "putObject"
	| "deleteObject"
	| "createList"
	| "renameList"
	| "setListOrder"
	| "setListSortMode"
	| "deleteList"
>;

/** The VTODO transforms ops use (src/server/caldav/ics.server.ts). */
export type TaskMapper = Pick<
	typeof ics,
	| "parseTask"
	| "buildVtodo"
	| "applyFields"
	| "applyComplete"
	| "applyUncomplete"
>;

export interface ApplyOpsContext {
	engine: OpsEngine;
	journal: OpJournal;
	accountKey: string;
	/** Batch start time; Python used one `now` for the whole batch. */
	now: Date;
	/** `X-Tasks-Client-Id` of the sending device, passed on in the poke. */
	sourceClientId?: string | null;
	/** Defaults to ics.server; tests pass a fake. */
	mapper?: TaskMapper;
	/** Defaults to realtime pokeUser; tests observe it. */
	poke?: (accountKey: string, sourceClientId: string | null) => Promise<void>;
}

type ApplyStatus = Extract<OpStatus, "applied" | "lww_reapplied" | "duplicate">;

/** A per-op failure: reported as `status: "error"`, the batch continues. */
class OpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpError";
	}
}

/** Lazily fetched Lists for locating tasks; list ops invalidate it. */
class ListCache {
	private lists: ListInfo[] | null = null;

	constructor(private readonly engine: OpsEngine) {}

	async get(): Promise<ListInfo[]> {
		if (this.lists === null) this.lists = await this.engine.listTaskLists();
		return this.lists;
	}

	invalidate(): void {
		this.lists = null;
	}
}

interface OpEnv {
	engine: OpsEngine;
	lists: ListCache;
	mapper: TaskMapper;
	now: Date;
}

const has = (op: WireOp, field: string) => Object.hasOwn(op, field);

function requireUid(op: WireOp): string {
	if (!op.uid) throw new OpError(`${op.kind} requires uid`);
	return op.uid;
}

function requireListId(op: WireOp): string {
	if (!op.list_id) throw new OpError(`${op.kind} requires list_id`);
	return op.list_id;
}

function requireToListId(op: WireOp): string {
	if (!op.to_list_id) throw new OpError(`${op.kind} requires to_list_id`);
	return op.to_list_id;
}

function requireStr(op: WireOp, field: string): string {
	const value = op[field];
	if (typeof value !== "string" || !value) {
		throw new OpError(`${op.kind} requires ${field}`);
	}
	return value;
}

/**
 * Python's `isinstance(value, int) and not isinstance(value, bool)`, limited
 * to safe integers: JSON numbers past 2^53 are not exact in JavaScript (and
 * `1e21` was a float to Python), so they are a per-op error, not a 500.
 */
function requireInt(op: WireOp, field: string): number {
	const value = op[field];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new OpError(`${op.kind} requires an integer ${field}`);
	}
	return value;
}

/** The task fields present on the op, values unvalidated (the mapper checks them). */
function mutableFields(op: WireOp): OpTaskFields {
	const fields: OpTaskFields = {};
	for (const field of MUTABLE_TASK_FIELDS) {
		if (has(op, field)) fields[field] = op[field];
	}
	return fields;
}

/** Locate a Task by UID: the hinted List first, then the rest in order. */
async function findTask(
	env: OpEnv,
	uid: string,
	hintListId: string | null | undefined,
): Promise<[ListInfo, ObjectState] | null> {
	const infos = await env.lists.get();
	const ordered = [
		...infos.filter((li) => li.id === hintListId),
		...infos.filter((li) => li.id !== hintListId),
	];
	for (const info of ordered) {
		const state = await env.engine.findTask(info.href, uid);
		if (state !== null) return [info, state];
	}
	return null;
}

async function requireTask(
	env: OpEnv,
	op: WireOp,
): Promise<[ListInfo, ObjectState]> {
	const uid = requireUid(op);
	const found = await findTask(env, uid, op.list_id);
	if (found === null) throw new OpError(`task ${pyRepr(uid)} not found`);
	return found;
}

/** Read-modify-write with If-Match; a 412 refetches and re-applies (Silent LWW). */
async function readModifyWrite(
	env: OpEnv,
	initial: ObjectState,
	transform: (ics: string) => string,
): Promise<ApplyStatus> {
	let state = initial;
	for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt++) {
		const next = transform(state.ics);
		try {
			await env.engine.putObject(state.href, next, {
				ifMatch: state.etag || null,
			});
		} catch (err) {
			if (!(err instanceof CalDAVPreconditionFailed)) throw err;
			try {
				state = await env.engine.getObject(state.href);
			} catch (refetchErr) {
				if (refetchErr instanceof CalDAVNotFound) {
					throw new OpError("task vanished while updating it");
				}
				throw refetchErr;
			}
			continue;
		}
		return attempt === 0 ? "applied" : "lww_reapplied";
	}
	throw new OpError(
		`etag conflict persisted after ${MAX_ETAG_RETRIES} attempts`,
	);
}

async function taskCreate(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const uid = requireUid(op);
	const listId = requireListId(op);
	const fields = mutableFields(op);
	if (!("title" in fields)) throw new OpError("task_create requires title");
	const body = env.mapper.buildVtodo(uid, fields, env.now);
	try {
		await env.engine.putObject(env.engine.objectPath(listId, uid), body, {
			ifNoneMatch: true,
		});
	} catch (err) {
		// The create UID already exists: a replay, not a new task.
		if (err instanceof CalDAVPreconditionFailed) return "duplicate";
		if (err instanceof CalDAVNotFound) {
			throw new OpError(`list ${pyRepr(listId)} not found`);
		}
		throw err;
	}
	return "applied";
}

async function taskUpdate(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const fields = mutableFields(op);
	if (Object.keys(fields).length === 0) {
		throw new OpError("task_update carries no task fields");
	}
	const [, state] = await requireTask(env, op);
	return readModifyWrite(env, state, (body) =>
		env.mapper.applyFields(body, fields, env.now),
	);
}

function parseCompletedAt(op: WireOp): Date | null {
	const raw = op.completed_at;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string") {
		throw new OpError(`invalid completed_at ${pyRepr(raw)}`);
	}
	try {
		return parsePythonIsoDatetime(raw);
	} catch (err) {
		if (err instanceof IsoFormatError) {
			throw new OpError(`invalid completed_at ${pyRepr(raw)}: ${err.message}`);
		}
		throw err;
	}
}

/**
 * The DUE the client saw for this occurrence. `provided` tells "absent" from
 * an explicit null (a task seen with no DUE): the guard fires only when the
 * client reported the occurrence it completed.
 */
function parseOccurrenceDue(op: WireOp): {
	provided: boolean;
	value: string | null;
} {
	if (!has(op, "occurrence_due")) return { provided: false, value: null };
	const raw = op.occurrence_due;
	if (raw === null) return { provided: true, value: null };
	if (typeof raw !== "string") {
		throw new OpError(`invalid occurrence_due ${pyRepr(raw)}`);
	}
	return { provided: true, value: raw };
}

async function taskComplete(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const completedAt = parseCompletedAt(op);
	const occurrence = parseOccurrenceDue(op);
	const [, state] = await requireTask(env, op);
	if (occurrence.provided) {
		const parsed = env.mapper.parseTask(state.ics);
		if (parsed?.recurring && parsed.due !== occurrence.value) {
			// DUE already advanced past the occurrence the client saw: this
			// completion was applied elsewhere; do not roll a second time (C).
			return "duplicate";
		}
	}
	return readModifyWrite(env, state, (body) =>
		env.mapper.applyComplete(body, env.now, completedAt),
	);
}

async function taskUncomplete(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const [, state] = await requireTask(env, op);
	return readModifyWrite(env, state, (body) =>
		env.mapper.applyUncomplete(body, env.now),
	);
}

async function taskDelete(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const uid = requireUid(op);
	const found = await findTask(env, uid, op.list_id);
	if (found === null) return "applied"; // the end state already holds
	let [, state] = found;
	for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt++) {
		try {
			await env.engine.deleteObject(state.href, {
				ifMatch: state.etag || null,
			});
		} catch (err) {
			if (err instanceof CalDAVNotFound) return "applied";
			if (!(err instanceof CalDAVPreconditionFailed)) throw err;
			try {
				state = await env.engine.getObject(state.href);
			} catch (refetchErr) {
				if (refetchErr instanceof CalDAVNotFound) return "applied";
				throw refetchErr;
			}
			continue;
		}
		return attempt === 0 ? "applied" : "lww_reapplied";
	}
	throw new OpError(
		`etag conflict persisted after ${MAX_ETAG_RETRIES} attempts`,
	);
}

/**
 * Move = PUT the same UID into the target List, then DELETE the source.
 * Locates the task in its SOURCE (the `list_id` hint) first, so a half-done
 * move that left a copy in the target does not shadow the source (contract A).
 */
async function taskMove(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const uid = requireUid(op);
	const toListId = requireToListId(op);
	const infos = await env.lists.get();
	const target = infos.find((li) => li.id === toListId);
	if (target === undefined) {
		throw new OpError(`list ${pyRepr(toListId)} not found`);
	}

	const found = await findTask(env, uid, op.list_id);
	if (found === null) {
		const alreadyThere = await env.engine.findTask(target.href, uid);
		if (alreadyThere !== null) return "duplicate"; // a finished move, replayed
		throw new OpError(`task ${pyRepr(uid)} not found`);
	}
	const [source, state] = found;
	if (source.id === toListId) return "duplicate"; // already in the target

	const targetHref = env.engine.objectPath(toListId, uid);
	try {
		await env.engine.putObject(targetHref, state.ics, { ifNoneMatch: true });
	} catch (err) {
		if (!(err instanceof CalDAVPreconditionFailed)) throw err;
		// A half-finished earlier move left a copy: last write wins.
		await env.engine.putObject(targetHref, state.ics);
	}
	try {
		await env.engine.deleteObject(state.href, { ifMatch: state.etag || null });
	} catch (err) {
		if (err instanceof CalDAVPreconditionFailed) {
			// The source changed under us; the move still wins (Silent LWW).
			await env.engine.deleteObject(state.href);
		} else if (!(err instanceof CalDAVNotFound)) {
			throw err;
		}
	}
	return "applied";
}

/** Run a PROPPATCH-style list op; 404 is a per-op error naming the List. */
async function onExistingList(
	listId: string,
	action: () => Promise<void>,
): Promise<ApplyStatus> {
	try {
		await action();
	} catch (err) {
		if (err instanceof CalDAVNotFound) {
			throw new OpError(`list ${pyRepr(listId)} not found`);
		}
		throw err;
	}
	return "applied";
}

async function listCreate(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const listId = requireListId(op);
	const name = requireStr(op, "name");
	if (!LIST_ID_RE.test(listId)) {
		throw new OpError(`invalid list_id ${pyRepr(listId)} (must be URL-safe)`);
	}
	env.lists.invalidate();
	try {
		await env.engine.createList(listId, name);
	} catch (err) {
		if (err instanceof CalDAVAlreadyExists) return "duplicate";
		throw err;
	}
	return "applied";
}

async function listRename(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const listId = requireListId(op);
	const name = requireStr(op, "name");
	env.lists.invalidate();
	return onExistingList(listId, () => env.engine.renameList(listId, name));
}

/** PROPPATCH `calendar-order` (v1.2). Re-setting the same value is a no-op apply. */
async function listReorder(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const listId = requireListId(op);
	const order = requireInt(op, "order");
	env.lists.invalidate();
	return onExistingList(listId, () => env.engine.setListOrder(listId, order));
}

/** PROPPATCH the `sort-mode` dead property (v1.4), idempotent like list_reorder. */
async function listSetSortMode(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const listId = requireListId(op);
	const raw = op.sort_mode;
	if (typeof raw !== "string" || !VALID_SORT_MODES.has(raw)) {
		throw new OpError(
			`${op.kind} requires sort_mode of ${SORT_MODES_REPR}, got ${pyRepr(raw)}`,
		);
	}
	env.lists.invalidate();
	return onExistingList(listId, () =>
		env.engine.setListSortMode(listId, raw as SortMode),
	);
}

async function listDelete(env: OpEnv, op: WireOp): Promise<ApplyStatus> {
	const listId = requireListId(op);
	env.lists.invalidate();
	try {
		await env.engine.deleteList(listId);
	} catch (err) {
		if (!(err instanceof CalDAVNotFound)) throw err; // gone already: applied
	}
	return "applied";
}

const HANDLERS: Record<
	OpKind,
	(env: OpEnv, op: WireOp) => Promise<ApplyStatus>
> = {
	task_create: taskCreate,
	task_update: taskUpdate,
	task_complete: taskComplete,
	task_uncomplete: taskUncomplete,
	task_delete: taskDelete,
	task_move: taskMove,
	list_create: listCreate,
	list_rename: listRename,
	list_reorder: listReorder,
	list_set_sort_mode: listSetSortMode,
	list_delete: listDelete,
};

const isPerOpError = (err: unknown): err is Error =>
	err instanceof OpError ||
	err instanceof MapperError ||
	err instanceof RecurrenceError;

export async function applyOps(
	ctx: ApplyOpsContext,
	ops: WireOp[],
): Promise<OpsResponse> {
	const { accountKey } = ctx;
	const env: OpEnv = {
		engine: ctx.engine,
		lists: new ListCache(ctx.engine),
		mapper: ctx.mapper ?? ics,
		now: ctx.now,
	};
	const journaled = await ctx.journal.journaledOpIds(
		accountKey,
		ops.map((op) => op.op_id),
	);
	const results: OpResult[] = [];
	const result = (
		op: WireOp,
		status: OpStatus,
		error: string | null = null,
	) => {
		results.push({ op_id: op.op_id, status, error });
		opsAppliedTotal.inc({
			kind: VALID_KINDS.has(op.kind) ? op.kind : "unknown",
			status,
		});
	};

	for (const op of ops) {
		if (journaled.has(op.op_id)) {
			result(op, "duplicate");
			continue;
		}
		if (!VALID_KINDS.has(op.kind)) {
			// An unknown kind is a permanent per-op error, never a batch 422 (B).
			result(op, "error", `unknown op kind ${pyRepr(op.kind)}`);
			continue;
		}
		let status: ApplyStatus;
		try {
			status = await HANDLERS[op.kind as OpKind](env, op);
		} catch (err) {
			if (err instanceof CalDAVUnauthorized) throw err; // 401: re-onboard
			if (err instanceof CalDAVTransient) {
				// Not applied. Stop here: this op and all later ones stay queued,
				// in order, for the next drain (contract B).
				log.info("op deferred, transient upstream failure — batch stopped", {
					user: accountKey,
					op_id: op.op_id,
					kind: op.kind,
					error: err.message,
				});
				result(op, "retry", err.message);
				break;
			}
			if (isPerOpError(err)) {
				result(op, "error", err.message);
				continue;
			}
			if (err instanceof CalDAVError) {
				log.warning("op failed against Nextcloud", {
					user: accountKey,
					op_id: op.op_id,
					kind: op.kind,
					error: err.message,
				});
				result(op, "error", err.message);
				continue;
			}
			throw err;
		}
		if (!(await ctx.journal.record(accountKey, op.op_id, op.kind, status))) {
			// Another in-flight request journaled this op_id first. The CalDAV
			// side is idempotent, so the effect happened once (contract C).
			result(op, "duplicate");
			continue;
		}
		journaled.add(op.op_id);
		if (status === "lww_reapplied") {
			log.info("silent LWW re-apply", {
				user: accountKey,
				op_id: op.op_id,
				kind: op.kind,
			});
		}
		result(op, status);
	}

	const counts: Partial<Record<OpStatus, number>> = {};
	for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
	log.info("ops batch applied", {
		user: accountKey,
		count: ops.length,
		statuses: counts,
	});

	if (
		results.some((r) => r.status === "applied" || r.status === "lww_reapplied")
	) {
		await poke(ctx);
	}
	return { results };
}

/** Tell the user's other devices to sync. Best effort: never fails the batch. */
async function poke(ctx: ApplyOpsContext): Promise<void> {
	const send = ctx.poke ?? pokeUser;
	try {
		await send(ctx.accountKey, ctx.sourceClientId ?? null);
	} catch (err) {
		log.warning("realtime poke failed", {
			user: ctx.accountKey,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
