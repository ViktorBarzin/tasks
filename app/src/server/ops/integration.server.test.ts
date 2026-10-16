/**
 * Ops and sync through the whole server-side stack, as backend/tests/test_ops.py,
 * test_sync.py and test_edge_conditionals.py drove it: the real CalDAVEngine
 * (DAV requests, XML parsing) over the ported fake_caldav transport, the real
 * ICS mapper and recurrence, applyOps and sync. ops.server.test.ts and
 * sync.server.test.ts cover the op and sync logic on an engine-level fake;
 * this suite checks the pieces fit together.
 *
 * Each scenario runs against a compliant server and through the openresty
 * edge that answers conditional writes itself (304 / 412), as the live
 * Nextcloud ingress does.
 */
import { describe, expect, test } from "bun:test";

import type { OpResult, Task, WireOp } from "#/shared/contract";
import { CalDAVEngine, type CalDAVTransport } from "../caldav/engine.server";
import type { FakeNextcloud } from "../caldav/testing/fake-nextcloud.server";
import {
	BASE_URL,
	loadGolden,
	NC_PASS,
	NC_USER,
	seededFakeNextcloud,
	unfoldLines,
} from "../caldav/testing/fixtures.server";
import { sync } from "../sync/sync.server";
import type { OpJournal } from "./journal.server";
import { applyOps } from "./ops.server";

const NC_SIMPLE_UID = "nc-web-3f2a1b4c5d6e";
const INFINITE_DAILY_UID = "infinite-daily-1";
const INFINITE_DAILY =
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 18.5//EN\r\n" +
	"BEGIN:VTODO\r\nCREATED:20260601T060000Z\r\nDTSTAMP:20260628T054500Z\r\n" +
	"DUE:20260701T054500Z\r\nLAST-MODIFIED:20260628T054500Z\r\n" +
	"RRULE:FREQ=DAILY\r\nSEQUENCE:0\r\nSTATUS:NEEDS-ACTION\r\n" +
	"SUMMARY:Infinite daily\r\nUID:infinite-daily-1\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";

class MemoryJournal implements OpJournal {
	readonly rows = new Set<string>();
	async journaledOpIds(accountKey: string, opIds: string[]) {
		return new Set(opIds.filter((id) => this.rows.has(`${accountKey}/${id}`)));
	}
	async record(accountKey: string, opId: string) {
		const key = `${accountKey}/${opId}`;
		if (this.rows.has(key)) return false;
		this.rows.add(key);
		return true;
	}
}

/** The live ingress: conditional writes never reach Nextcloud. */
function brokenEdge(fake: FakeNextcloud): CalDAVTransport {
	return async (request) => {
		if (
			request.method === "PUT" &&
			request.headers.get("If-None-Match") === "*"
		)
			return new Response(null, { status: 304 });
		if (
			(request.method === "PUT" || request.method === "DELETE") &&
			request.headers.has("If-Match")
		)
			return new Response(null, { status: 412 });
		return fake.handler(request);
	};
}

function setup(transportFor: (fake: FakeNextcloud) => CalDAVTransport) {
	const nc = seededFakeNextcloud();
	const journal = new MemoryJournal();
	const engine = () =>
		new CalDAVEngine({
			baseUrl: BASE_URL,
			ncUsername: NC_USER,
			appPassword: NC_PASS,
			transport: transportFor(nc),
		});
	const post = async (...ops: WireOp[]): Promise<OpResult[]> => {
		const { results } = await applyOps(
			{
				engine: engine(),
				journal,
				accountKey: "viktor",
				now: new Date(),
				poke: async () => {},
			},
			ops,
		);
		expect(results.map((r) => r.op_id)).toEqual(ops.map((o) => o.op_id));
		return results;
	};
	const snapshot = (cursor = "") => sync(engine(), cursor, "viktor");
	const task = async (uid: string): Promise<Task | undefined> =>
		(await snapshot()).tasks.find((t) => t.uid === uid);
	const stored = (calId: string, filename: string) =>
		nc.getObject(NC_USER, calId, filename).ics;
	return { nc, post, snapshot, task, stored };
}

const op = (kind: string, opId: string, fields: Record<string, unknown> = {}) =>
	({ op_id: opId, kind, ...fields }) as WireOp;

const TRANSPORTS: [string, (fake: FakeNextcloud) => CalDAVTransport][] = [
	["a compliant server", (fake) => fake.handler],
	["the broken edge", brokenEdge],
];

describe.each(TRANSPORTS)("ops and sync against %s", (_name, transport) => {
	test("create honours notes and an all-day due, written as a DATE", async () => {
		const s = setup(transport);
		const [result] = await s.post(
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
		expect(result?.status).toBe("applied");
		const task = await s.task("full-create");
		expect(task?.notes).toBe("the balcony ones\nand the ficus");
		expect(task?.due).toBe("2026-07-12");
		expect(task?.due_has_time).toBe(false);
		expect(task?.priority).toBe(9);
		expect(unfoldLines(s.stored("work", "full-create.ics"))).toContain(
			"DUE;VALUE=DATE:20260712",
		);
	});

	test("a second create with the same UID is a duplicate and changes nothing", async () => {
		const s = setup(transport);
		await s.post(
			op("task_create", "e1", {
				uid: "edge-uid-1",
				list_id: "work",
				title: "First wins",
			}),
		);
		const [result] = await s.post(
			op("task_create", "e2", {
				uid: "edge-uid-1",
				list_id: "work",
				title: "Usurper",
			}),
		);
		expect(result).toEqual({ op_id: "e2", status: "duplicate", error: null });
		expect(s.stored("work", "edge-uid-1.ics")).toContain("SUMMARY:First wins");
	});

	test("update finds a task stored under a foreign filename (UID calendar-query)", async () => {
		const s = setup(transport);
		const oddball = loadGolden("nextcloud_simple.ics").replace(
			`UID:${NC_SIMPLE_UID}`,
			"UID:oddly-named-task",
		);
		s.nc.putIcs(NC_USER, "work", "1D5C9A2E-legacy-apple-name.ics", oddball);
		const [result] = await s.post(
			op("task_update", "u1", { uid: "oddly-named-task", title: "renamed" }),
		);
		expect(result?.status).toBe("applied");
		expect((await s.task("oddly-named-task"))?.title).toBe("renamed");
	});

	test("update applies and sync shows it", async () => {
		const s = setup(transport);
		const [result] = await s.post(
			op("task_update", "e1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				title: "Edited",
			}),
		);
		expect(result).toEqual({ op_id: "e1", status: "applied", error: null });
		expect(s.stored("work", `${NC_SIMPLE_UID}.ics`)).toContain(
			"SUMMARY:Edited",
		);
		expect((await s.task(NC_SIMPLE_UID))?.title).toBe("Edited");
	});

	test("a concurrent edit is kept and the op lands on top (last writer wins)", async () => {
		const s = setup(transport);
		const filename = `${NC_SIMPLE_UID}.ics`;
		s.nc.addAfterGetHook(filename, () => {
			const current = s.stored("work", filename);
			const edited = current.replace(
				"SUMMARY:Ring insurer about policy renewal",
				"SUMMARY:Renamed elsewhere",
			);
			expect(edited).not.toBe(current);
			s.nc.putIcs(NC_USER, "work", filename, edited);
		});
		const [result] = await s.post(
			op("task_update", "e1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				notes: "mine",
			}),
		);
		expect(result).toEqual({
			op_id: "e1",
			status: "lww_reapplied",
			error: null,
		});
		const stored = s.stored("work", filename);
		expect(stored).toContain("SUMMARY:Renamed elsewhere");
		expect(stored).toContain("DESCRIPTION:mine");
	});

	test("complete on a non-recurring task closes it", async () => {
		const s = setup(transport);
		const [result] = await s.post(
			op("task_complete", "d1", {
				uid: NC_SIMPLE_UID,
				list_id: "work",
				completed_at: "2026-07-02T08:30:00+00:00",
			}),
		);
		expect(result).toEqual({ op_id: "d1", status: "applied", error: null });
		expect(s.stored("work", `${NC_SIMPLE_UID}.ics`)).toContain(
			"STATUS:COMPLETED",
		);
		const task = await s.task(NC_SIMPLE_UID);
		expect(task?.completed).toBe(true);
		expect(task?.completed_at).toBe("2026-07-02T08:30:00+00:00");
	});

	test("complete on a recurring task rolls it forward past now; a replay does not roll again", async () => {
		const s = setup(transport);
		s.nc.putIcs(
			NC_USER,
			"personal",
			`${INFINITE_DAILY_UID}.ics`,
			INFINITE_DAILY,
		);
		const complete = op("task_complete", "d1", { uid: INFINITE_DAILY_UID });
		expect((await s.post(complete))[0]?.status).toBe("applied");
		const task = await s.task(INFINITE_DAILY_UID);
		expect(task?.completed).toBe(false);
		expect(task?.recurring).toBe(true);
		expect(new Date(task?.due ?? 0).getTime()).toBeGreaterThan(Date.now());
		expect((await s.post(complete))[0]?.status).toBe("duplicate");
		expect((await s.task(INFINITE_DAILY_UID))?.due).toBe(task?.due ?? "");
	});

	test("occurrence_due that matches rolls from completed_at; a stale one is a duplicate", async () => {
		const s = setup(transport);
		s.nc.putIcs(
			NC_USER,
			"personal",
			`${INFINITE_DAILY_UID}.ics`,
			INFINITE_DAILY,
		);
		const stale = await s.post(
			op("task_complete", "d0", {
				uid: INFINITE_DAILY_UID,
				completed_at: "2026-07-01T06:00:00+00:00",
				occurrence_due: "2026-06-30T05:45:00+00:00",
			}),
		);
		expect(stale[0]?.status).toBe("duplicate");
		expect((await s.task(INFINITE_DAILY_UID))?.due).toBe(
			"2026-07-01T05:45:00+00:00",
		);
		const matched = await s.post(
			op("task_complete", "d1", {
				uid: INFINITE_DAILY_UID,
				completed_at: "2026-07-01T06:00:00+00:00",
				occurrence_due: "2026-07-01T05:45:00+00:00",
			}),
		);
		expect(matched[0]?.status).toBe("applied");
		const task = await s.task(INFINITE_DAILY_UID);
		expect(task?.completed).toBe(false);
		expect(task?.due).toBe("2026-07-02T05:45:00+00:00");
	});

	test("delete removes the object; a delta sync carries the tombstone", async () => {
		const s = setup(transport);
		const before = await s.snapshot();
		const [result] = await s.post(
			op("task_delete", "x1", { uid: NC_SIMPLE_UID, list_id: "work" }),
		);
		expect(result).toEqual({ op_id: "x1", status: "applied", error: null });
		expect(
			s.nc.calendars
				.get(NC_USER)
				?.get("work")
				?.objects.has(`${NC_SIMPLE_UID}.ics`),
		).toBe(false);
		const delta = await s.snapshot(before.cursor);
		expect(delta.tasks.some((t) => t.deleted && t.uid === NC_SIMPLE_UID)).toBe(
			true,
		);
	});

	test("list ops apply in one batch; an unsafe order is a per-op error and the batch goes on", async () => {
		const s = setup(transport);
		const results = await s.post(
			op("list_create", "l1", {
				list_id: "groceries",
				name: "Groceries & <stuff>",
			}),
			op("task_create", "l2", {
				uid: "g-1",
				list_id: "groceries",
				title: "milk",
			}),
			op("list_rename", "l3", { list_id: "groceries", name: "Food" }),
			op("list_reorder", "l4", { list_id: "groceries", order: 1e21 }),
			op("list_reorder", "l5", { list_id: "groceries", order: 2 ** 60 }),
			op("list_reorder", "l6", { list_id: "groceries", order: 3 }),
			op("list_set_sort_mode", "l7", {
				list_id: "groceries",
				sort_mode: "due",
			}),
		);
		expect(results.map((r) => r.status)).toEqual([
			"applied",
			"applied",
			"applied",
			"error",
			"error",
			"applied",
			"applied",
		]);
		const snap = await s.snapshot();
		const list = snap.lists.find((l) => l.id === "groceries");
		expect(list).toMatchObject({ name: "Food", order: 3, sort_mode: "due" });
		expect(snap.tasks.some((t) => t.uid === "g-1")).toBe(true);
	});
});

test("an edge that swallows every PUT surfaces an error instead of looping", async () => {
	const s = setup(
		(fake) => async (request) =>
			request.method === "PUT"
				? new Response(null, { status: 304 })
				: fake.handler(request),
	);
	const [result] = await s.post(
		op("task_create", "e1", {
			uid: "edge-uid-1",
			list_id: "work",
			title: "Doomed",
		}),
	);
	expect(result?.status).toBe("error");
	expect(result?.error ?? "").toContain("304");
});
