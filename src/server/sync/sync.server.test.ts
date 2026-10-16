/**
 * GET /api/sync semantics. Port of backend/tests/test_sync.py onto the
 * engine-level fake Nextcloud (src/test/fake-nextcloud.server.ts).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { SyncResponse, Task } from "#/shared/contract";
import {
	APPLE_DAILY_UID,
	APPLE_TIMED_UID,
	type FakeNextcloud,
	fakeMapper,
	fakeUidHintFromHref,
	NC_PASS,
	NC_SIMPLE_TITLE,
	NC_SIMPLE_UID,
	NC_USER,
	ncSimple,
	seededNextcloud,
} from "#/test/fake-nextcloud.server";
import { encodeCursor } from "./cursor.server";
import { sync } from "./sync.server";

const APPLE_ALLDAY_UID = "0D9E1F2A-3B4C-5D6E-7F80-91A2B3C4D5E6";

let nc: FakeNextcloud;

beforeEach(() => {
	nc = seededNextcloud();
});

function run(cursor = ""): Promise<SyncResponse> {
	return sync(nc.engine(NC_USER, NC_PASS), cursor, "viktor", {
		parseTask: fakeMapper.parseTask,
		uidHintFromHref: fakeUidHintFromHref,
	});
}

function taskByUid(payload: SyncResponse, uid: string): Task {
	const matches = payload.tasks.filter((t) => t.uid === uid);
	expect(matches).toHaveLength(1);
	return matches[0] as Task;
}

const listTriples = (payload: SyncResponse) =>
	new Set(payload.lists.map((li) => `${li.id}|${li.name}|${li.deleted}`));

describe("full snapshot", () => {
	test("empty cursor: full snapshot shape", async () => {
		const payload = await run();
		expect(Object.keys(payload)).toEqual(["cursor", "full", "lists", "tasks"]);
		expect(payload.full).toBe(true);
		expect(payload.cursor).not.toBe("");
		// VTODO-capable lists only: the VEVENT-only Birthdays calendar is not a List.
		expect(listTriples(payload)).toEqual(
			new Set(["personal|Personal|false", "work|Work|false"]),
		);
		expect(new Set(payload.tasks.map((t) => t.uid))).toEqual(
			new Set([
				APPLE_TIMED_UID,
				APPLE_ALLDAY_UID,
				APPLE_DAILY_UID,
				NC_SIMPLE_UID,
			]),
		);
	});

	test("task fields match the contract, in wire order", async () => {
		const payload = await run();
		const timed = taskByUid(payload, APPLE_TIMED_UID);
		expect(Object.keys(timed)).toEqual([
			"uid",
			"list_id",
			"title",
			"notes",
			"due",
			"due_has_time",
			"priority",
			"sort_order",
			"completed",
			"completed_at",
			"recurring",
			"deleted",
		]);
		expect(timed).toMatchObject({
			list_id: "personal",
			due: "2026-07-01T09:00:00+03:00",
			due_has_time: true,
			priority: 1,
			sort_order: 740609486,
			completed: false,
			recurring: true,
			deleted: false,
		});
		expect(taskByUid(payload, APPLE_ALLDAY_UID)).toMatchObject({
			due: "2026-06-15",
			due_has_time: false,
			completed: true,
			completed_at: "2026-06-15T19:15:00+00:00",
		});
		expect(taskByUid(payload, NC_SIMPLE_UID)).toMatchObject({
			list_id: "work",
			due: null,
			priority: 0,
			recurring: false,
			sort_order: null,
		});
	});

	test("list fields match the contract, in wire order", async () => {
		for (const li of (await run()).lists) {
			expect(Object.keys(li)).toEqual([
				"id",
				"name",
				"order",
				"sort_mode",
				"deleted",
			]);
		}
	});

	test("an undecodable cursor is a full snapshot", async () => {
		const payload = await run("corrupted-blob-from-2019");
		expect(payload.full).toBe(true);
		expect(payload.tasks).toHaveLength(4);
	});

	test("an unparseable object is skipped, not fatal", async () => {
		nc.putIcs(
			NC_USER,
			"work",
			"corrupt.ics",
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID\r\nEND:VCALENDAR\r\n",
		);
		const payload = await run();
		expect(payload.full).toBe(true);
		expect(payload.tasks).toHaveLength(4);
	});

	test("an object without a UID is skipped", async () => {
		nc.putIcs(
			NC_USER,
			"work",
			"no-uid.ics",
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n",
		);
		expect((await run()).tasks).toHaveLength(4);
	});
});

describe("list properties ship in snapshot and delta", () => {
	test("order", async () => {
		nc.calendar(NC_USER, "work").order = 1;
		const payload = await run();
		expect(payload.lists.map((li) => [li.id, li.order])).toEqual([
			["personal", null],
			["work", 1],
		]);
		nc.calendar(NC_USER, "work").order = 0;
		nc.calendar(NC_USER, "personal").order = 2;
		const delta = await run(payload.cursor);
		expect(delta.full).toBe(false);
		expect(delta.lists.map((li) => [li.id, li.order])).toEqual([
			["personal", 2],
			["work", 0],
		]);
	});

	test("sort_mode", async () => {
		nc.calendar(NC_USER, "work").sortMode = "priority";
		const payload = await run();
		expect(payload.lists.map((li) => [li.id, li.sort_mode])).toEqual([
			["personal", null],
			["work", "priority"],
		]);
		nc.calendar(NC_USER, "work").sortMode = "due";
		nc.calendar(NC_USER, "personal").sortMode = "custom";
		const delta = await run(payload.cursor);
		expect(delta.full).toBe(false);
		expect(delta.lists.map((li) => [li.id, li.sort_mode])).toEqual([
			["personal", "custom"],
			["work", "due"],
		]);
	});
});

describe("delta", () => {
	test("a quiet delta is empty", async () => {
		const first = await run();
		const second = await run(first.cursor);
		expect(second.full).toBe(false);
		expect(second.tasks).toEqual([]);
		expect(second.lists.filter((li) => !li.deleted).map((li) => li.id)).toEqual(
			["personal", "work"],
		);
		expect((await run(second.cursor)).tasks).toEqual([]);
	});

	test("an external edit shows up", async () => {
		const { cursor } = await run();
		nc.putIcs(
			NC_USER,
			"work",
			`${NC_SIMPLE_UID}.ics`,
			ncSimple().replace(
				`SUMMARY:${NC_SIMPLE_TITLE}`,
				"SUMMARY:Ring insurer TODAY",
			),
		);
		const payload = await run(cursor);
		expect(payload.full).toBe(false);
		expect(taskByUid(payload, NC_SIMPLE_UID)).toMatchObject({
			title: "Ring insurer TODAY",
			deleted: false,
		});
		expect(payload.tasks).toHaveLength(1);
	});

	test("an external delete ships a tombstone", async () => {
		const { cursor } = await run();
		nc.deleteIcs(NC_USER, "personal", `${APPLE_DAILY_UID}.ics`);
		const payload = await run(cursor);
		expect(payload.full).toBe(false);
		expect(taskByUid(payload, APPLE_DAILY_UID)).toEqual({
			uid: APPLE_DAILY_UID,
			list_id: "personal",
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
		});
	});

	test("a delete tombstone carries the true UID, not the filename", async () => {
		nc.putIcs(
			NC_USER,
			"work",
			"1D5C9A2E-legacy-apple-name.ics",
			ncSimple("oddly-named-task"),
		);
		const { cursor } = await run(); // the full snapshot builds the href index
		nc.deleteIcs(NC_USER, "work", "1D5C9A2E-legacy-apple-name.ics");
		const payload = await run(cursor);
		expect(payload.full).toBe(false);
		expect(taskByUid(payload, "oddly-named-task")).toMatchObject({
			deleted: true,
			list_id: "work",
		});
		expect(
			payload.tasks.some((t) => t.uid === "1D5C9A2E-legacy-apple-name"),
		).toBe(false);
	});

	test("the href index survives a delta that edits the oddball", async () => {
		nc.putIcs(NC_USER, "work", "legacy.ics", ncSimple("odd-uid"));
		const first = await run();
		nc.putIcs(NC_USER, "work", "legacy.ics", ncSimple("odd-uid"));
		const second = await run(first.cursor);
		nc.deleteIcs(NC_USER, "work", "legacy.ics");
		const third = await run(second.cursor);
		expect(taskByUid(third, "odd-uid").deleted).toBe(true);
	});

	test("a delete tombstone uses the filename when it equals the UID", async () => {
		const { cursor } = await run();
		nc.deleteIcs(NC_USER, "personal", `${APPLE_DAILY_UID}.ics`);
		expect(taskByUid(await run(cursor), APPLE_DAILY_UID).deleted).toBe(true);
	});

	test("an external create shows up", async () => {
		const { cursor } = await run();
		nc.putIcs(
			NC_USER,
			"work",
			"nc-web-000000000new.ics",
			ncSimple("nc-web-000000000new"),
		);
		const payload = await run(cursor);
		expect(payload.full).toBe(false);
		expect(taskByUid(payload, "nc-web-000000000new").title).toBe(
			NC_SIMPLE_TITLE,
		);
	});

	test("a new List ships whole", async () => {
		const { cursor } = await run();
		nc.addCalendar(NC_USER, "garden", "Garden");
		nc.putIcs(
			NC_USER,
			"garden",
			"garden-task-1.ics",
			ncSimple("garden-task-1"),
		);
		const payload = await run(cursor);
		expect(payload.full).toBe(false);
		expect(listTriples(payload).has("garden|Garden|false")).toBe(true);
		expect(taskByUid(payload, "garden-task-1").list_id).toBe("garden");
		expect((await run(payload.cursor)).tasks).toEqual([]);
	});

	test("a deleted List ships a List tombstone, after the live Lists", async () => {
		const { cursor } = await run();
		nc.userCalendars(NC_USER).delete("work");
		const payload = await run(cursor);
		expect(payload.full).toBe(false);
		expect(payload.lists).toEqual([
			{
				id: "personal",
				name: "Personal",
				order: null,
				sort_mode: null,
				deleted: false,
			},
			{ id: "work", name: "", order: null, sort_mode: null, deleted: true },
		]);
	});

	test("List tombstones are sorted by id", async () => {
		nc.addCalendar(NC_USER, "b-list", "B");
		nc.addCalendar(NC_USER, "a-list", "A");
		const { cursor } = await run();
		nc.userCalendars(NC_USER).delete("b-list");
		nc.userCalendars(NC_USER).delete("a-list");
		const payload = await run(cursor);
		expect(payload.lists.filter((li) => li.deleted).map((li) => li.id)).toEqual(
			["a-list", "b-list"],
		);
	});

	test("an expired sync-token escalates to a full snapshot", async () => {
		const bogus = encodeCursor({
			personal: "http://elsewhere/ns/sync/999",
			work: "http://elsewhere/ns/sync/999",
		});
		const payload = await run(bogus);
		expect(payload.full).toBe(true);
		expect(payload.tasks).toHaveLength(4);
		const quiet = await run(payload.cursor);
		expect(quiet.full).toBe(false);
		expect(quiet.tasks).toEqual([]);
	});

	test("a List deleted mid-cycle escalates to a full snapshot", async () => {
		const { cursor } = await run();
		// listTaskLists still reports "work", but its delta REPORT 404s.
		nc.fault = (method, path) => {
			if (method === "REPORT" && path.includes("/work/")) {
				nc.fault = undefined;
				nc.userCalendars(NC_USER).delete("work");
				return undefined;
			}
			return undefined;
		};
		const payload = await run(cursor);
		expect(payload.full).toBe(true);
		expect(payload.lists.map((li) => li.id)).toEqual(["personal"]);
	});
});

describe("byte compatibility", () => {
	test("the response serialises in Pydantic's field order", async () => {
		nc = seededNextcloud();
		nc.userCalendars(NC_USER).delete("personal");
		const payload = await run();
		const cursor = payload.cursor;
		expect(JSON.stringify(payload)).toBe(
			`{"cursor":"${cursor}","full":true,"lists":[{"id":"work","name":"Work","order":null,"sort_mode":null,"deleted":false}],"tasks":[{"uid":"${NC_SIMPLE_UID}","list_id":"work","title":"${NC_SIMPLE_TITLE}","notes":"","due":null,"due_has_time":false,"priority":0,"sort_order":null,"completed":false,"completed_at":null,"recurring":false,"deleted":false}]}`,
		);
	});
});
