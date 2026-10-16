/**
 * POST /api/ops semantics: idempotent replay, Silent LWW and per-op isolation.
 * Port of backend/tests/test_ops.py (and the ops half of test_errors.py)
 * onto the engine-level fake Nextcloud and an in-memory journal. The
 * Postgres journal has its own test (journal.server.test.ts), and the route
 * is exercised end to end in src/server/account/api.server.test.ts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	CalDAVError,
	CalDAVTransient,
	CalDAVUnauthorized,
} from "#/server/caldav/engine.server";
import { sync } from "#/server/sync/sync.server";
import {
	type OpResult,
	type OpStatus,
	PRIORITIES,
	type SyncResponse,
	type Task,
	type WireOp,
} from "#/shared/contract";
import {
	type FakeNextcloud,
	fakeMapper,
	fakeUidHintFromHref,
	fakeVtodo,
	NC_PASS,
	NC_SIMPLE_TITLE,
	NC_SIMPLE_UID,
	NC_USER,
	ncSimple,
	seededNextcloud,
} from "#/test/fake-nextcloud.server";
import type { OpJournal } from "./journal.server";
import { applyOps, MAX_ETAG_RETRIES } from "./ops.server";

const INFINITE_DAILY_UID = "infinite-daily-1";
const INFINITE_DAILY = fakeVtodo({
	UID: INFINITE_DAILY_UID,
	SUMMARY: "Infinite daily",
	DUE: "2026-07-01T05:45:00+00:00",
	"X-DUE-HAS-TIME": "TRUE",
	RRULE: "FREQ=DAILY",
	STATUS: "NEEDS-ACTION",
});

/** applied_ops in memory, with the Python test's "blind pre-check" switch. */
class MemoryJournal implements OpJournal {
	readonly rows = new Map<string, { kind: string; status: OpStatus }>();
	blindPrecheck = false;

	async journaledOpIds(accountKey: string, opIds: string[]) {
		if (this.blindPrecheck) return new Set<string>();
		return new Set(opIds.filter((id) => this.rows.has(`${accountKey}/${id}`)));
	}

	async record(
		accountKey: string,
		opId: string,
		kind: string,
		status: OpStatus,
	) {
		const key = `${accountKey}/${opId}`;
		if (this.rows.has(key)) return false;
		this.rows.set(key, { kind, status });
		return true;
	}
}

let nc: FakeNextcloud;
let journal: MemoryJournal;
let pokes: Array<[string, string | null]>;
let pokeError: Error | undefined;

beforeEach(() => {
	nc = seededNextcloud();
	journal = new MemoryJournal();
	pokes = [];
	pokeError = undefined;
});

const op = (kind: string, opId: string, fields: Record<string, unknown> = {}) =>
	({ op_id: opId, kind, ...fields }) as WireOp;

async function rawOps(
	ops: WireOp[],
	options: { now?: Date; clientId?: string | null } = {},
): Promise<OpResult[]> {
	const engine = nc.engine(NC_USER, NC_PASS);
	const response = await applyOps(
		{
			engine,
			journal,
			accountKey: "viktor",
			now: options.now ?? new Date(),
			sourceClientId: options.clientId ?? null,
			mapper: fakeMapper,
			poke: async (accountKey, clientId) => {
				if (pokeError) throw pokeError;
				pokes.push([accountKey, clientId]);
			},
		},
		ops,
	);
	expect(Object.keys(response)).toEqual(["results"]);
	for (const result of response.results) {
		expect(Object.keys(result)).toEqual(["op_id", "status", "error"]);
	}
	return response.results;
}

/** Like the Python post_ops: one result per op, in order. */
async function postOps(...ops: WireOp[]): Promise<OpResult[]> {
	const results = await rawOps(ops);
	expect(results.map((r) => r.op_id)).toEqual(ops.map((o) => o.op_id));
	return results;
}

const statuses = (results: OpResult[]) => results.map((r) => r.status);

function runSync(cursor = ""): Promise<SyncResponse> {
	return sync(nc.engine(NC_USER, NC_PASS), cursor, "viktor", {
		parseTask: fakeMapper.parseTask,
		uidHintFromHref: fakeUidHintFromHref,
	});
}

async function taskByUid(uid: string, payload?: SyncResponse): Promise<Task> {
	const matches = (payload ?? (await runSync())).tasks.filter(
		(t) => t.uid === uid,
	);
	expect(matches).toHaveLength(1);
	return matches[0] as Task;
}

const objects = (calId: string) => nc.calendar(NC_USER, calId).objects;

// ---------------------------------------------------------------- task_create

describe("task_create", () => {
	test("applied and visible", async () => {
		const results = await postOps(
			op("task_create", "c1", {
				uid: "client-uid-1",
				list_id: "work",
				title: "Write the report",
				notes: "by Friday",
				due: "2026-07-10T09:00:00+00:00",
				due_has_time: true,
				priority: 5,
			}),
		);
		expect(results).toEqual([{ op_id: "c1", status: "applied", error: null }]);
		expect(await taskByUid("client-uid-1")).toMatchObject({
			list_id: "work",
			title: "Write the report",
			notes: "by Friday",
			due: "2026-07-10T09:00:00+00:00",
			priority: 5,
			completed: false,
		});
	});

	test("carries sort_order", async () => {
		await postOps(
			op("task_create", "c1", {
				uid: "ordered-1",
				list_id: "work",
				title: "Last",
				sort_order: 5120,
			}),
		);
		expect((await taskByUid("ordered-1")).sort_order).toBe(5120);
	});

	test("a replayed op_id is a duplicate", async () => {
		const create = op("task_create", "c1", {
			uid: "client-uid-1",
			list_id: "work",
			title: "Once",
		});
		expect(statuses(await postOps(create))).toEqual(["applied"]);
		expect(statuses(await postOps(create))).toEqual(["duplicate"]);
		await taskByUid("client-uid-1"); // exactly one copy
	});

	test("the same UID under a new op_id is a duplicate; first write wins", async () => {
		await postOps(
			op("task_create", "c1", {
				uid: "client-uid-1",
				list_id: "work",
				title: "A",
			}),
		);
		const results = await postOps(
			op("task_create", "c2", {
				uid: "client-uid-1",
				list_id: "work",
				title: "A again",
			}),
		);
		expect(statuses(results)).toEqual(["duplicate"]);
		expect((await taskByUid("client-uid-1")).title).toBe("A");
		// The duplicate is journaled, so a third replay never reaches Nextcloud.
		expect(journal.rows.get("viktor/c2")?.status).toBe("duplicate");
	});

	test("a duplicate op_id within one batch", async () => {
		const create = op("task_create", "c1", {
			uid: "u-1",
			list_id: "work",
			title: "A",
		});
		expect(statuses(await postOps(create, create))).toEqual([
			"applied",
			"duplicate",
		]);
	});

	test("a missing List errors that op; the batch continues", async () => {
		const results = await postOps(
			op("task_create", "c1", { uid: "u-1", list_id: "nope", title: "lost" }),
			op("task_create", "c2", { uid: "u-2", list_id: "work", title: "kept" }),
		);
		expect(results[0]?.status).toBe("error");
		expect(results[0]?.error).toBe("list 'nope' not found");
		expect(results[1]).toEqual({ op_id: "c2", status: "applied", error: null });
		expect((await taskByUid("u-2")).title).toBe("kept");
	});

	test("without a title errors", async () => {
		const [result] = await postOps(
			op("task_create", "c1", { uid: "u-1", list_id: "work" }),
		);
		expect(result).toEqual({
			op_id: "c1",
			status: "error",
			error: "task_create requires title",
		});
	});

	test("without a uid or list_id errors", async () => {
		const results = await postOps(
			op("task_create", "c1", { list_id: "work", title: "x" }),
			op("task_create", "c2", { uid: "u", list_id: null, title: "x" }),
			op("task_create", "c3", { uid: "", list_id: "work", title: "x" }),
		);
		expect(results.map((r) => r.error)).toEqual([
			"task_create requires uid",
			"task_create requires list_id",
			"task_create requires uid",
		]);
	});

	for (const priority of PRIORITIES) {
		test(`honours priority ${priority}`, async () => {
			await postOps(
				op("task_create", "c1", {
					uid: "prio-task",
					list_id: "work",
					title: "P",
					priority,
				}),
			);
			expect((await taskByUid("prio-task")).priority).toBe(priority);
		});
	}

	test("a mapper rejection (invalid priority) is a per-op error", async () => {
		const [result] = await postOps(
			op("task_create", "c1", {
				uid: "bad-prio",
				list_id: "work",
				title: "x",
				priority: 3,
			}),
		);
		expect(result?.status).toBe("error");
		expect(result?.error).toContain("priority");
		expect(journal.rows.size).toBe(0); // errors are never journaled
	});

	test("honours notes and an all-day due", async () => {
		await postOps(
			op("task_create", "c1", {
				uid: "full-create",
				list_id: "work",
				title: "Water plants",
				notes: "the balcony ones\nand the ficus",
				due: "2026-07-12",
				due_has_time: false,
				priority: 9,
			}),
		);
		expect(await taskByUid("full-create")).toMatchObject({
			notes: "the balcony ones\nand the ficus",
			due: "2026-07-12",
			due_has_time: false,
			priority: 9,
		});
	});

	test("PUTs to <uid>.ics with If-None-Match", async () => {
		await postOps(
			op("task_create", "c1", { uid: "a b/c", list_id: "work", title: "x" }),
		);
		expect(objects("work").has("a b/c.ics")).toBe(true);
	});
});

// ---------------------------------------------------------------- task_update

describe("task_update", () => {
	test("applied; untouched fields survive", async () => {
		const results = await postOps(
			op("task_update", "u1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				title: "Ring insurer NOW",
				priority: 1,
			}),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(await taskByUid(NC_SIMPLE_UID)).toMatchObject({
			title: "Ring insurer NOW",
			priority: 1,
			notes: "",
		});
	});

	test("finds the task without a List hint", async () => {
		const results = await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, title: "found you" }),
		);
		expect(statuses(results)).toEqual(["applied"]);
	});

	test("searches the hinted List first", async () => {
		await postOps(
			op("task_update", "u1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				title: "x",
			}),
		);
		const firstGet = nc.requests.find(([method]) => method === "GET");
		expect(firstGet?.[1]).toContain("/work/");
	});

	test("finds a task stored under a foreign filename", async () => {
		nc.putIcs(
			NC_USER,
			"work",
			"1D5C9A2E-legacy-apple-name.ics",
			ncSimple("oddly-named-task"),
		);
		const results = await postOps(
			op("task_update", "u1", { uid: "oddly-named-task", title: "renamed" }),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect((await taskByUid("oddly-named-task")).title).toBe("renamed");
	});

	test("a stale ETag re-applies on top of the server copy (Silent LWW)", async () => {
		const filename = `${NC_SIMPLE_UID}.ics`;
		// Fires between the engine's GET and its If-Match PUT: a guaranteed 412.
		nc.addAfterGetHook(filename, () => {
			const current = nc.getObject(NC_USER, "work", filename).ics;
			nc.putIcs(
				NC_USER,
				"work",
				filename,
				current.replace(
					"STATUS:NEEDS-ACTION",
					"STATUS:NEEDS-ACTION\r\nDESCRIPTION:racy",
				),
			);
		});
		const results = await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, title: "my title wins" }),
		);
		expect(statuses(results)).toEqual(["lww_reapplied"]);
		expect(await taskByUid(NC_SIMPLE_UID)).toMatchObject({
			title: "my title wins",
			notes: "racy",
		});
		expect(journal.rows.get("viktor/u1")?.status).toBe("lww_reapplied");
	});

	test(`a conflict that persists for ${MAX_ETAG_RETRIES} attempts errors`, async () => {
		const filename = `${NC_SIMPLE_UID}.ics`;
		const meddle = () => {
			const current = nc.getObject(NC_USER, "work", filename).ics;
			nc.putIcs(NC_USER, "work", filename, current);
			nc.addAfterGetHook(filename, meddle);
		};
		nc.addAfterGetHook(filename, meddle);
		const [result] = await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, title: "never" }),
		);
		expect(result).toEqual({
			op_id: "u1",
			status: "error",
			error: "etag conflict persisted after 3 attempts",
		});
		const puts = nc.requests.filter(([method]) => method === "PUT");
		expect(puts).toHaveLength(MAX_ETAG_RETRIES);
	});

	test("a task deleted mid-update errors", async () => {
		const filename = `${NC_SIMPLE_UID}.ics`;
		nc.addAfterGetHook(filename, () => nc.deleteIcs(NC_USER, "work", filename));
		const [result] = await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, title: "gone" }),
		);
		expect(result?.error).toBe("task vanished while updating it");
	});

	test("a missing task errors", async () => {
		const [result] = await postOps(
			op("task_update", "u1", { uid: "ghost", title: "x" }),
		);
		expect(result).toEqual({
			op_id: "u1",
			status: "error",
			error: "task 'ghost' not found",
		});
	});

	test("no task fields errors", async () => {
		const [result] = await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, name: "not a task field" }),
		);
		expect(result?.error).toBe("task_update carries no task fields");
	});

	test("sets sort_order", async () => {
		await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, sort_order: 3584 }),
		);
		expect(await taskByUid(NC_SIMPLE_UID)).toMatchObject({
			sort_order: 3584,
			title: NC_SIMPLE_TITLE,
		});
	});

	test("clears sort_order with null", async () => {
		await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, sort_order: 99 }),
		);
		const results = await postOps(
			op("task_update", "u2", { uid: NC_SIMPLE_UID, sort_order: null }),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect((await taskByUid(NC_SIMPLE_UID)).sort_order).toBeNull();
	});

	test("an invalid sort_order errors; the batch continues", async () => {
		const results = await postOps(
			op("task_update", "u1", { uid: NC_SIMPLE_UID, sort_order: true }),
			op("task_update", "u2", { uid: NC_SIMPLE_UID, sort_order: 2048 }),
		);
		expect(statuses(results)).toEqual(["error", "applied"]);
		expect((await taskByUid(NC_SIMPLE_UID)).sort_order).toBe(2048);
	});
});

// ---------------------------------------------------------------- task_complete

describe("task_complete / task_uncomplete", () => {
	test("completes a non-recurring task at the client's instant", async () => {
		const results = await postOps(
			op("task_complete", "d1", {
				uid: NC_SIMPLE_UID,
				completed_at: "2026-07-02T08:30:00+00:00",
			}),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(await taskByUid(NC_SIMPLE_UID)).toMatchObject({
			completed: true,
			completed_at: "2026-07-02T08:30:00+00:00",
		});
	});

	test("a naive completed_at is UTC, a Z suffix and milliseconds parse", async () => {
		await postOps(
			op("task_complete", "d1", {
				uid: NC_SIMPLE_UID,
				completed_at: "2026-07-02T08:30:00",
			}),
		);
		expect((await taskByUid(NC_SIMPLE_UID)).completed_at).toBe(
			"2026-07-02T08:30:00+00:00",
		);
		nc.putIcs(NC_USER, "work", "z.ics", ncSimple("z"));
		await postOps(
			op("task_complete", "d2", {
				uid: "z",
				completed_at: "2026-07-02T10:30:00.123+02:00",
			}),
		);
		expect((await taskByUid("z")).completed_at).toBe(
			"2026-07-02T08:30:00+00:00",
		);
	});

	test("a recurring task rolls forward", async () => {
		nc.putIcs(NC_USER, "personal", `${INFINITE_DAILY_UID}.ics`, INFINITE_DAILY);
		const results = await postOps(
			op("task_complete", "d1", { uid: INFINITE_DAILY_UID }),
		);
		expect(statuses(results)).toEqual(["applied"]);
		const task = await taskByUid(INFINITE_DAILY_UID);
		expect(task.completed).toBe(false);
		expect(task.recurring).toBe(true);
		expect(new Date(task.due ?? 0).getTime()).toBeGreaterThan(Date.now());
	});

	test("a replay does not roll twice", async () => {
		nc.putIcs(NC_USER, "personal", `${INFINITE_DAILY_UID}.ics`, INFINITE_DAILY);
		const complete = op("task_complete", "d1", { uid: INFINITE_DAILY_UID });
		expect(statuses(await postOps(complete))).toEqual(["applied"]);
		const dueAfterFirst = (await taskByUid(INFINITE_DAILY_UID)).due;
		expect(statuses(await postOps(complete))).toEqual(["duplicate"]);
		expect((await taskByUid(INFINITE_DAILY_UID)).due).toBe(dueAfterFirst);
	});

	test("a matching occurrence_due rolls from completed_at, not now", async () => {
		nc.putIcs(NC_USER, "personal", `${INFINITE_DAILY_UID}.ics`, INFINITE_DAILY);
		const results = await postOps(
			op("task_complete", "d1", {
				uid: INFINITE_DAILY_UID,
				completed_at: "2026-07-01T06:00:00+00:00",
				occurrence_due: "2026-07-01T05:45:00+00:00",
			}),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(await taskByUid(INFINITE_DAILY_UID)).toMatchObject({
			completed: false,
			due: "2026-07-02T05:45:00+00:00",
		});
	});

	test("a stale occurrence_due is a duplicate and does not roll", async () => {
		nc.putIcs(NC_USER, "personal", `${INFINITE_DAILY_UID}.ics`, INFINITE_DAILY);
		const results = await postOps(
			op("task_complete", "d1", {
				uid: INFINITE_DAILY_UID,
				completed_at: "2026-07-01T06:00:00+00:00",
				occurrence_due: "2026-06-30T05:45:00+00:00",
			}),
		);
		expect(statuses(results)).toEqual(["duplicate"]);
		expect((await taskByUid(INFINITE_DAILY_UID)).due).toBe(
			"2026-07-01T05:45:00+00:00",
		);
	});

	test("occurrence_due is ignored for a non-recurring task", async () => {
		const results = await postOps(
			op("task_complete", "d1", {
				uid: NC_SIMPLE_UID,
				occurrence_due: "2020-01-01",
			}),
		);
		expect(statuses(results)).toEqual(["applied"]);
	});

	test("a journal race resolves to duplicate, never a crash", async () => {
		const complete = op("task_complete", "d1", { uid: NC_SIMPLE_UID });
		expect(statuses(await postOps(complete))).toEqual(["applied"]);
		journal.blindPrecheck = true; // the pre-check misses the existing row
		expect(statuses(await postOps(complete))).toEqual(["duplicate"]);
	});

	test("invalid completed_at / occurrence_due values error", async () => {
		const results = await postOps(
			op("task_complete", "d1", {
				uid: NC_SIMPLE_UID,
				completed_at: "yesterdayish",
			}),
			op("task_complete", "d2", { uid: NC_SIMPLE_UID, completed_at: 5 }),
			op("task_complete", "d3", { uid: NC_SIMPLE_UID, occurrence_due: 5 }),
			op("task_complete", "d4", {
				uid: NC_SIMPLE_UID,
				completed_at: "2026-13-01",
			}),
		);
		expect(results.map((r) => r.error)).toEqual([
			"invalid completed_at 'yesterdayish': Invalid isoformat string: 'yesterdayish'",
			"invalid completed_at 5",
			"invalid occurrence_due 5",
			"invalid completed_at '2026-13-01': month must be in 1..12",
		]);
	});

	test("uncomplete reopens", async () => {
		await postOps(op("task_complete", "d1", { uid: NC_SIMPLE_UID }));
		const results = await postOps(
			op("task_uncomplete", "d2", { uid: NC_SIMPLE_UID }),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(await taskByUid(NC_SIMPLE_UID)).toMatchObject({
			completed: false,
			completed_at: null,
		});
	});
});

// ---------------------------------------------------------------- task_delete

describe("task_delete", () => {
	test("applied and tombstoned", async () => {
		const { cursor } = await runSync();
		const results = await postOps(
			op("task_delete", "x1", { uid: NC_SIMPLE_UID }),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(objects("work").has(`${NC_SIMPLE_UID}.ics`)).toBe(false);
		expect(
			(await taskByUid(NC_SIMPLE_UID, await runSync(cursor))).deleted,
		).toBe(true);
	});

	test("a missing task is applied (the end state holds)", async () => {
		expect(
			statuses(await postOps(op("task_delete", "x1", { uid: "ghost" }))),
		).toEqual(["applied"]);
	});

	test("a replay is a duplicate", async () => {
		const del = op("task_delete", "x1", { uid: NC_SIMPLE_UID });
		expect(statuses(await postOps(del))).toEqual(["applied"]);
		expect(statuses(await postOps(del))).toEqual(["duplicate"]);
	});

	test("a stale ETag refetches and deletes (lww_reapplied)", async () => {
		const filename = `${NC_SIMPLE_UID}.ics`;
		nc.addAfterGetHook(filename, () =>
			nc.putIcs(NC_USER, "work", filename, ncSimple()),
		);
		expect(
			statuses(await postOps(op("task_delete", "x1", { uid: NC_SIMPLE_UID }))),
		).toEqual(["lww_reapplied"]);
		expect(objects("work").has(filename)).toBe(false);
	});
});

// ---------------------------------------------------------------- task_move

describe("task_move", () => {
	test("preserves the UID across Lists", async () => {
		const results = await postOps(
			op("task_move", "m1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				to_list_id: "personal",
			}),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(await taskByUid(NC_SIMPLE_UID)).toMatchObject({
			list_id: "personal",
			title: NC_SIMPLE_TITLE,
		});
		expect(objects("work").has(`${NC_SIMPLE_UID}.ics`)).toBe(false);
	});

	test("a replay under a new op_id is a duplicate via the target check", async () => {
		const move = (id: string) =>
			op("task_move", id, {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				to_list_id: "personal",
			});
		await postOps(move("m1"));
		expect(statuses(await postOps(move("m2")))).toEqual(["duplicate"]);
	});

	test("a missing target List errors", async () => {
		const [result] = await postOps(
			op("task_move", "m1", { uid: NC_SIMPLE_UID, to_list_id: "nope" }),
		);
		expect(result?.error).toBe("list 'nope' not found");
	});

	test("a missing task errors", async () => {
		const [result] = await postOps(
			op("task_move", "m1", { uid: "ghost", to_list_id: "personal" }),
		);
		expect(result?.error).toBe("task 'ghost' not found");
	});

	test("without to_list_id errors", async () => {
		const [result] = await postOps(
			op("task_move", "m1", { uid: NC_SIMPLE_UID, list_id: "work" }),
		);
		expect(result?.error).toBe("task_move requires to_list_id");
	});

	test("within the same List is a duplicate", async () => {
		expect(
			statuses(
				await postOps(
					op("task_move", "m1", { uid: NC_SIMPLE_UID, to_list_id: "work" }),
				),
			),
		).toEqual(["duplicate"]);
	});

	test("locates in the source first, not a shadow copy in the target", async () => {
		nc.putIcs(NC_USER, "personal", `${NC_SIMPLE_UID}.ics`, ncSimple());
		const results = await postOps(
			op("task_move", "m1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				to_list_id: "personal",
			}),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(objects("work").has(`${NC_SIMPLE_UID}.ics`)).toBe(false);
		expect((await taskByUid(NC_SIMPLE_UID)).list_id).toBe("personal");
	});

	test("a source changed mid-move is still deleted (the move wins)", async () => {
		const filename = `${NC_SIMPLE_UID}.ics`;
		nc.addAfterGetHook(filename, () =>
			nc.putIcs(NC_USER, "work", filename, ncSimple()),
		);
		const results = await postOps(
			op("task_move", "m1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				to_list_id: "personal",
			}),
		);
		expect(statuses(results)).toEqual(["applied"]);
		expect(objects("work").has(filename)).toBe(false);
		expect(objects("personal").has(filename)).toBe(true);
	});
});

// ---------------------------------------------------------------- Lists

describe("list ops", () => {
	test("list_create then task_create in the same batch", async () => {
		const results = await postOps(
			op("list_create", "l1", { list_id: "garden", name: "Garden" }),
			op("task_create", "l2", {
				uid: "g-1",
				list_id: "garden",
				title: "Plant tomatoes",
			}),
		);
		expect(statuses(results)).toEqual(["applied", "applied"]);
		const payload = await runSync();
		expect(
			payload.lists.some((li) => li.id === "garden" && li.name === "Garden"),
		).toBe(true);
		expect((await taskByUid("g-1", payload)).list_id).toBe("garden");
	});

	test("a task op after list_create sees the new List (cache invalidated)", async () => {
		await postOps(
			op("task_update", "w1", { uid: NC_SIMPLE_UID, title: "warm" }),
		);
		const results = await postOps(
			op("task_update", "w2", { uid: NC_SIMPLE_UID, title: "warm cache" }),
			op("list_create", "l1", { list_id: "garden", name: "Garden" }),
			op("task_create", "l2", { uid: "g-1", list_id: "garden", title: "x" }),
			op("task_move", "l3", {
				uid: "g-1",
				list_id: "garden",
				to_list_id: "work",
			}),
		);
		expect(statuses(results)).toEqual([
			"applied",
			"applied",
			"applied",
			"applied",
		]);
	});

	test("list_create replay is a duplicate", async () => {
		await postOps(
			op("list_create", "l1", { list_id: "garden", name: "Garden" }),
		);
		expect(
			statuses(
				await postOps(
					op("list_create", "l2", { list_id: "garden", name: "Garden" }),
				),
			),
		).toEqual(["duplicate"]);
	});

	test("list_create with an unsafe id errors", async () => {
		const [result] = await postOps(
			op("list_create", "l1", { list_id: "../escape", name: "X" }),
		);
		expect(result?.error).toBe(
			"invalid list_id '../escape' (must be URL-safe)",
		);
	});

	test("list_create without a name errors", async () => {
		const results = await postOps(
			op("list_create", "l1", { list_id: "garden" }),
			op("list_create", "l2", { list_id: "garden", name: "" }),
			op("list_create", "l3", { list_id: "garden", name: 5 }),
		);
		expect(results.map((r) => r.error)).toEqual([
			"list_create requires name",
			"list_create requires name",
			"list_create requires name",
		]);
	});

	test("list_rename", async () => {
		expect(
			statuses(
				await postOps(
					op("list_rename", "l1", { list_id: "work", name: "Werk" }),
				),
			),
		).toEqual(["applied"]);
		expect((await runSync()).lists.find((li) => li.id === "work")?.name).toBe(
			"Werk",
		);
	});

	test("list_rename of a missing List errors", async () => {
		const [result] = await postOps(
			op("list_rename", "l1", { list_id: "nope", name: "X" }),
		);
		expect(result?.error).toBe("list 'nope' not found");
	});

	test("list_reorder PROPPATCHes calendar-order and shows in sync", async () => {
		const results = await postOps(
			op("list_reorder", "r1", { list_id: "work", order: 0 }),
		);
		expect(results).toEqual([{ op_id: "r1", status: "applied", error: null }]);
		expect(nc.calendar(NC_USER, "work").order).toBe(0);
		expect(nc.requests).toContainEqual([
			"PROPPATCH",
			"/remote.php/dav/calendars/viktor-nc/work/",
		]);
		const lists = (await runSync()).lists;
		expect(lists.find((li) => li.id === "work")?.order).toBe(0);
		expect(lists.find((li) => li.id === "personal")?.order).toBeNull();
	});

	test("list_reorder orders several Lists in one batch", async () => {
		const results = await postOps(
			op("list_reorder", "r1", { list_id: "personal", order: 1 }),
			op("list_reorder", "r2", { list_id: "work", order: 0 }),
		);
		expect(statuses(results)).toEqual(["applied", "applied"]);
		expect(nc.calendar(NC_USER, "personal").order).toBe(1);
		expect(nc.calendar(NC_USER, "work").order).toBe(0);
	});

	test("list_reorder replay is a duplicate; same value new op_id applies", async () => {
		const reorder = op("list_reorder", "r1", { list_id: "work", order: 3 });
		expect(statuses(await postOps(reorder))).toEqual(["applied"]);
		expect(statuses(await postOps(reorder))).toEqual(["duplicate"]);
		expect(
			statuses(
				await postOps(op("list_reorder", "r2", { list_id: "work", order: 3 })),
			),
		).toEqual(["applied"]);
	});

	test("list_reorder of a missing List errors", async () => {
		const [result] = await postOps(
			op("list_reorder", "r1", { list_id: "nope", order: 1 }),
		);
		expect(result?.error).toBe("list 'nope' not found");
	});

	for (const bad of [null, "first", 1.5, true, undefined, 1e21, 2 ** 60]) {
		test(`list_reorder with order ${JSON.stringify(bad)} errors`, async () => {
			const fields: Record<string, unknown> = { list_id: "work" };
			if (bad !== undefined) fields.order = bad;
			const [result] = await postOps(op("list_reorder", "r1", fields));
			expect(result?.error).toBe("list_reorder requires an integer order");
		});
	}

	for (const mode of ["custom", "priority", "due"]) {
		test(`list_set_sort_mode ${mode} PROPPATCHes and shows in sync`, async () => {
			const results = await postOps(
				op("list_set_sort_mode", "m1", { list_id: "work", sort_mode: mode }),
			);
			expect(results).toEqual([
				{ op_id: "m1", status: "applied", error: null },
			]);
			expect(nc.calendar(NC_USER, "work").sortMode).toBe(mode);
			const lists = (await runSync()).lists;
			expect(lists.find((li) => li.id === "work")?.sort_mode).toBe(
				mode as never,
			);
			expect(lists.find((li) => li.id === "personal")?.sort_mode).toBeNull();
		});
	}

	test("list_set_sort_mode replay is a duplicate; same value new op_id applies", async () => {
		const setMode = op("list_set_sort_mode", "m1", {
			list_id: "work",
			sort_mode: "due",
		});
		expect(statuses(await postOps(setMode))).toEqual(["applied"]);
		expect(statuses(await postOps(setMode))).toEqual(["duplicate"]);
		expect(
			statuses(
				await postOps(
					op("list_set_sort_mode", "m2", { list_id: "work", sort_mode: "due" }),
				),
			),
		).toEqual(["applied"]);
	});

	test("list_set_sort_mode of a missing List errors", async () => {
		const [result] = await postOps(
			op("list_set_sort_mode", "m1", { list_id: "nope", sort_mode: "due" }),
		);
		expect(result?.error).toBe("list 'nope' not found");
	});

	const badModes: Array<[unknown, string]> = [
		[null, "None"],
		[42, "42"],
		[true, "True"],
		["alphabetical", "'alphabetical'"],
		["", "''"],
		["Priority", "'Priority'"],
		[undefined, "None"],
	];
	for (const [bad, repr] of badModes) {
		test(`list_set_sort_mode ${JSON.stringify(bad)} errors; the batch continues`, async () => {
			const fields: Record<string, unknown> = { list_id: "work" };
			if (bad !== undefined) fields.sort_mode = bad;
			const results = await postOps(
				op("list_set_sort_mode", "m1", fields),
				op("list_set_sort_mode", "m2", {
					list_id: "work",
					sort_mode: "priority",
				}),
			);
			expect(statuses(results)).toEqual(["error", "applied"]);
			expect(results[0]?.error).toBe(
				`list_set_sort_mode requires sort_mode of ['custom', 'due', 'priority'], got ${repr}`,
			);
			expect(nc.calendar(NC_USER, "work").sortMode).toBe("priority");
		});
	}

	test("list_delete and its tombstone", async () => {
		const { cursor } = await runSync();
		expect(
			statuses(await postOps(op("list_delete", "l1", { list_id: "work" }))),
		).toEqual(["applied"]);
		expect(nc.userCalendars(NC_USER).has("work")).toBe(false);
		const delta = await runSync(cursor);
		expect(delta.lists.find((li) => li.id === "work")?.deleted).toBe(true);
	});

	test("list_delete of a missing List is applied", async () => {
		expect(
			statuses(await postOps(op("list_delete", "l1", { list_id: "nope" }))),
		).toEqual(["applied"]);
	});

	test("list ops without list_id error", async () => {
		const results = await postOps(
			op("list_rename", "a", { name: "x" }),
			op("list_delete", "b"),
		);
		expect(results.map((r) => r.error)).toEqual([
			"list_rename requires list_id",
			"list_delete requires list_id",
		]);
	});
});

// ---------------------------------------------------------------- batch semantics

describe("batch semantics", () => {
	test("an empty batch", async () => {
		expect(await postOps()).toEqual([]);
		expect(pokes).toEqual([]);
	});

	test("an unknown kind is a per-op error, not a batch failure", async () => {
		const results = await postOps(
			op("task_explode", "z1", { uid: "u" }),
			op("task_create", "z2", {
				uid: "keep-1",
				list_id: "work",
				title: "kept",
			}),
		);
		expect(results[0]).toEqual({
			op_id: "z1",
			status: "error",
			error: "unknown op kind 'task_explode'",
		});
		expect(results[1]?.status).toBe("applied");
		expect((await taskByUid("keep-1")).title).toBe("kept");
	});

	test("a full replay of a mixed batch is all duplicates; effects happened once", async () => {
		const batch = [
			op("list_create", "b1", { list_id: "garden", name: "Garden" }),
			op("task_create", "b2", {
				uid: "g-1",
				list_id: "garden",
				title: "Plant",
			}),
			op("task_complete", "b3", { uid: "g-1" }),
		];
		expect(statuses(await postOps(...batch))).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		expect(statuses(await postOps(...batch))).toEqual([
			"duplicate",
			"duplicate",
			"duplicate",
		]);
		expect((await taskByUid("g-1")).completed).toBe(true);
	});

	test("journal rows are per user", async () => {
		await postOps(op("list_reorder", "r1", { list_id: "work", order: 1 }));
		expect([...journal.rows.keys()]).toEqual(["viktor/r1"]);
		expect(journal.rows.get("viktor/r1")).toEqual({
			kind: "list_reorder",
			status: "applied",
		});
	});
});

// ---------------------------------------------------------------- retry vs error

const failPutsInto = (calId: string, error: () => Error) => {
	nc.fault = (method, path) =>
		method === "PUT" && path.includes(`/${calId}/`) ? error() : undefined;
};

describe("retry vs error taxonomy", () => {
	test("a transient failure stops the batch at retry and omits the rest", async () => {
		failPutsInto(
			"personal",
			() => new CalDAVTransient("PUT x: upstream HTTP 503"),
		);
		const results = await rawOps([
			op("task_create", "b1", {
				uid: "ok-before",
				list_id: "work",
				title: "before",
			}),
			op("task_create", "b2", {
				uid: "stuck",
				list_id: "personal",
				title: "stuck",
			}),
			op("task_create", "b3", {
				uid: "never-tried",
				list_id: "work",
				title: "after",
			}),
		]);
		expect(results).toEqual([
			{ op_id: "b1", status: "applied", error: null },
			{ op_id: "b2", status: "retry", error: "PUT x: upstream HTTP 503" },
		]);
		expect(objects("work").has("ok-before.ics")).toBe(true);
		expect(objects("work").has("never-tried.ics")).toBe(false);
	});

	test("a retry is not journaled, so a resend applies", async () => {
		let failures = 1;
		nc.fault = (method, path) => {
			if (method === "PUT" && path.includes("/personal/") && failures > 0) {
				failures -= 1;
				return new CalDAVTransient("upstream HTTP 502");
			}
			return undefined;
		};
		const create = op("task_create", "r1", {
			uid: "retry-me",
			list_id: "personal",
			title: "x",
		});
		expect(statuses(await rawOps([create]))).toEqual(["retry"]);
		expect(statuses(await rawOps([create]))).toEqual(["applied"]);
	});

	test("a permanent CalDAV failure is an isolated error", async () => {
		failPutsInto("personal", () => new CalDAVError("PUT x failed: HTTP 403"));
		const results = await rawOps([
			op("task_create", "e1", {
				uid: "doomed",
				list_id: "personal",
				title: "no",
			}),
			op("task_create", "e2", { uid: "fine", list_id: "work", title: "yes" }),
		]);
		expect(results).toEqual([
			{ op_id: "e1", status: "error", error: "PUT x failed: HTTP 403" },
			{ op_id: "e2", status: "applied", error: null },
		]);
		expect(objects("work").has("fine.ics")).toBe(true);
	});

	test("a rejected stored credential aborts the whole batch", async () => {
		nc.users.set(NC_USER, "rotated-by-nextcloud");
		await expect(
			rawOps([op("list_create", "op-1", { list_id: "x", name: "X" })]),
		).rejects.toBeInstanceOf(CalDAVUnauthorized);
		expect(journal.rows.size).toBe(0);
	});

	test("an unexpected exception propagates (a 500, as in Python)", async () => {
		nc.fault = () => new TypeError("boom");
		await expect(
			rawOps([op("list_create", "op-1", { list_id: "x", name: "X" })]),
		).rejects.toBeInstanceOf(TypeError);
	});
});

// ---------------------------------------------------------------- realtime poke

describe("realtime poke", () => {
	test("one poke per batch that applied something, with the source client id", async () => {
		await rawOps(
			[
				op("list_reorder", "r1", { list_id: "work", order: 1 }),
				op("list_reorder", "r2", { list_id: "work", order: 2 }),
			],
			{ clientId: "device-a" },
		);
		expect(pokes).toEqual([["viktor", "device-a"]]);
	});

	test("lww_reapplied counts as applied", async () => {
		const filename = `${NC_SIMPLE_UID}.ics`;
		nc.addAfterGetHook(filename, () =>
			nc.putIcs(NC_USER, "work", filename, ncSimple()),
		);
		await rawOps([op("task_update", "u1", { uid: NC_SIMPLE_UID, title: "t" })]);
		expect(pokes).toEqual([["viktor", null]]);
	});

	test("no poke when nothing applied", async () => {
		const reorder = op("list_reorder", "r1", { list_id: "work", order: 1 });
		await rawOps([reorder]);
		pokes = [];
		await rawOps([
			reorder,
			op("task_explode", "z"),
			op("task_update", "u", { uid: "ghost", title: "x" }),
		]);
		expect(pokes).toEqual([]);
	});

	test("a failed poke does not fail the batch", async () => {
		pokeError = new Error("NOTIFY failed");
		const results = await rawOps([
			op("list_reorder", "r1", { list_id: "work", order: 1 }),
		]);
		expect(statuses(results)).toEqual(["applied"]);
	});
});
