/**
 * GET /api/sync: delta sync between the PWA replica and Nextcloud.
 * Port of backend/tasks_api/routers/sync.py.
 *
 * An empty or undecodable cursor means a full snapshot. Otherwise each List's
 * sync-token drives an RFC 6578 delta; a token the server no longer honours
 * (CalDAVSyncTokenInvalid) or a List deleted mid-cycle (CalDAVNotFound)
 * escalates the whole response to a full snapshot (`full: true`). Lists ship
 * whole in every response; a List gone since the cursor ships as a tombstone
 * (`deleted: true`, name "", order null, sort_mode null), sorted by id.
 * Task tombstones carry the true UID from the cursor's href index.
 */
import type { SyncResponse, Task, TaskList } from "#/shared/contract";
import {
	CalDAVEngine,
	CalDAVNotFound,
	CalDAVSyncTokenInvalid,
	type ListInfo,
	type ObjectState,
} from "../caldav/engine.server";
import { MapperError, parseTask } from "../caldav/ics.server";
import { getLogger } from "../logging.server";
import {
	decodeCursor,
	decodeHrefIndex,
	encodeCursor,
	type HrefIndex,
	type SyncTokens,
} from "./cursor.server";

const log = getLogger("tasks.sync");

/** The engine methods sync uses; tests pass the fake Nextcloud's engine. */
export type SyncEngine = Pick<
	CalDAVEngine,
	"listTaskLists" | "getSyncToken" | "fetchAllTasks" | "syncDelta"
>;

/** The VTODO parser and href helper; tests swap in fakes. */
export interface SyncDeps {
	parseTask: (ics: string) => ReturnType<typeof parseTask>;
	uidHintFromHref: (href: string) => string;
}

const defaultDeps: SyncDeps = {
	parseTask,
	uidHintFromHref: (href) => CalDAVEngine.uidHintFromHref(href),
};

/** The wire shape of a live List; Lists ship whole in every response (v1.4 §1). */
function listEntry(li: ListInfo): TaskList {
	return {
		id: li.id,
		name: li.name,
		order: li.order,
		sort_mode: li.sortMode,
		deleted: false,
	};
}

function listTombstone(id: string): TaskList {
	return { id, name: "", order: null, sort_mode: null, deleted: true };
}

function taskFromState(
	deps: SyncDeps,
	state: ObjectState,
	listId: string,
): Task | null {
	let parsed: ReturnType<typeof parseTask>;
	try {
		parsed = deps.parseTask(state.ics);
	} catch (err) {
		if (!(err instanceof MapperError)) throw err;
		log.warning("skipping unparseable object", {
			href: state.href,
			error: err.message,
		});
		return null;
	}
	if (parsed === null || !parsed.uid) return null;
	// Keys in Pydantic's declaration order (src/shared/contract.ts).
	return {
		uid: parsed.uid,
		list_id: listId,
		title: parsed.title,
		notes: parsed.notes,
		due: parsed.due,
		due_has_time: parsed.due_has_time,
		priority: parsed.priority,
		sort_order: parsed.sort_order,
		completed: parsed.completed,
		completed_at: parsed.completed_at,
		recurring: parsed.recurring,
		deleted: false,
	};
}

function taskTombstone(uid: string, listId: string): Task {
	return {
		uid,
		list_id: listId,
		title: "",
		notes: "",
		due: null,
		due_has_time: false,
		priority: 0,
		sort_order: null,
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: true,
	};
}

/**
 * Record `href -> uid` only when the filename is not the UID (Apple-legacy
 * names), so a later delete tombstone carries the real UID (contract D).
 */
function indexOddball(
	deps: SyncDeps,
	index: HrefIndex,
	href: string,
	uid: string,
): void {
	if (deps.uidHintFromHref(href) !== uid) index[href] = uid;
}

/**
 * Sync-token first, objects second: a change in between is reported again
 * by the next delta (at-least-once) instead of being lost.
 */
async function fullListState(
	engine: SyncEngine,
	deps: SyncDeps,
	info: ListInfo,
	index: HrefIndex,
): Promise<{ token: string; tasks: Task[] }> {
	const token = await engine.getSyncToken(info.href);
	const states = await engine.fetchAllTasks(info.href);
	const tasks: Task[] = [];
	for (const state of states) {
		const task = taskFromState(deps, state, info.id);
		if (task !== null) {
			tasks.push(task);
			indexOddball(deps, index, state.href, task.uid);
		}
	}
	return { token, tasks };
}

async function fullSnapshot(
	engine: SyncEngine,
	deps: SyncDeps,
	lists: ListInfo[],
): Promise<SyncResponse> {
	const tokens: SyncTokens = {};
	const tasks: Task[] = [];
	const index: HrefIndex = {};
	for (const info of lists) {
		const state = await fullListState(engine, deps, info, index);
		tokens[info.id] = state.token;
		tasks.push(...state.tasks);
	}
	return {
		cursor: encodeCursor(tokens, index),
		full: true,
		lists: lists.map(listEntry),
		tasks,
	};
}

async function delta(
	engine: SyncEngine,
	deps: SyncDeps,
	lists: ListInfo[],
	oldTokens: SyncTokens,
	oldIndex: HrefIndex,
): Promise<SyncResponse> {
	const tokens: SyncTokens = {};
	const tasks: Task[] = [];
	const index: HrefIndex = { ...oldIndex }; // carry the index forward
	const listEntries = lists.map(listEntry);
	for (const info of lists) {
		const oldToken = Object.hasOwn(oldTokens, info.id)
			? oldTokens[info.id]
			: undefined;
		if (oldToken === undefined) {
			// A List the client has never seen: ship it whole.
			const state = await fullListState(engine, deps, info, index);
			tokens[info.id] = state.token;
			tasks.push(...state.tasks);
			continue;
		}
		const result = await engine.syncDelta(info.href, oldToken);
		tokens[info.id] = result.syncToken;
		for (const state of result.changed) {
			const task = taskFromState(deps, state, info.id);
			if (task !== null) {
				tasks.push(task);
				indexOddball(deps, index, state.href, task.uid);
			}
		}
		for (const href of result.removedHrefs) {
			// The common <uid>.ics case is not indexed and falls back to the filename.
			const indexed = Object.hasOwn(index, href) ? index[href] : undefined;
			delete index[href];
			tasks.push(taskTombstone(indexed || deps.uidHintFromHref(href), info.id));
		}
	}
	const current = new Set(lists.map((li) => li.id));
	const gone = Object.keys(oldTokens)
		.filter((id) => !current.has(id))
		.sort();
	listEntries.push(...gone.map(listTombstone));
	return {
		cursor: encodeCursor(tokens, index),
		full: false,
		lists: listEntries,
		tasks,
	};
}

export async function sync(
	engine: SyncEngine,
	cursor: string,
	accountKey: string,
	deps: SyncDeps = defaultDeps,
): Promise<SyncResponse> {
	const oldTokens = decodeCursor(cursor);
	let lists = await engine.listTaskLists();
	let response: SyncResponse;
	if (oldTokens === null) {
		response = await fullSnapshot(engine, deps, lists);
	} else {
		try {
			response = await delta(
				engine,
				deps,
				lists,
				oldTokens,
				decodeHrefIndex(cursor),
			);
		} catch (err) {
			if (
				!(
					err instanceof CalDAVSyncTokenInvalid || err instanceof CalDAVNotFound
				)
			) {
				throw err;
			}
			// An expired token, or a List deleted and recreated mid-cycle: resync.
			log.info("delta impossible, escalating to full snapshot", {
				user: accountKey,
				reason: err.message,
			});
			lists = await engine.listTaskLists();
			response = await fullSnapshot(engine, deps, lists);
		}
	}
	log.info("sync served", {
		user: accountKey,
		full: response.full,
		lists: response.lists.length,
		tasks: response.tasks.length,
	});
	return response;
}
