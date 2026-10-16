/**
 * CalDAVEngine against the fake Nextcloud (testing/fake-nextcloud.server.ts).
 *
 * The Python suite exercised the engine through the HTTP routers
 * (test_onboarding, test_sync, test_ops, test_edge_conditionals). Those
 * router tests belong to the onboarding, sync and ops ports; this file pins
 * the engine-level behaviour each of them relies on, case by case, so the
 * routers can trust it. test_edge_conditionals.py is ported here in full at
 * the engine level, since the edge fallbacks live entirely in the engine.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { SortMode } from "#/shared/contract";
import {
	CalDAVAlreadyExists,
	CalDAVEngine,
	CalDAVError,
	CalDAVNotFound,
	CalDAVPreconditionFailed,
	CalDAVSyncTokenInvalid,
	CalDAVTransient,
	type CalDAVTransport,
	CalDAVUnauthorized,
} from "./engine.server";
import { BASE_PATH, type FakeNextcloud } from "./testing/fake-nextcloud.server";
import {
	BASE_URL,
	loadGolden,
	NC_PASS,
	NC_USER,
	seededFakeNextcloud,
} from "./testing/fixtures.server";

let fake: FakeNextcloud;
let engine: CalDAVEngine;

function engineWith(
	transport: CalDAVTransport,
	options: { password?: string; timeoutMs?: number } = {},
): CalDAVEngine {
	return new CalDAVEngine({
		baseUrl: BASE_URL,
		ncUsername: NC_USER,
		appPassword: options.password ?? NC_PASS,
		transport,
		timeoutMs: options.timeoutMs,
	});
}

beforeEach(() => {
	fake = seededFakeNextcloud();
	engine = engineWith(fake.handler);
});

const PERSONAL = `${BASE_PATH}/calendars/${NC_USER}/personal/`;
const WORK = `${BASE_PATH}/calendars/${NC_USER}/work/`;
const NC_SIMPLE = `${WORK}nc-web-3f2a1b4c5d6e.ics`;

const minimalTodo = (uid: string, summary = "x") =>
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VTODO\r\n" +
	`UID:${uid}\r\nSUMMARY:${summary}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;

describe("paths", () => {
	test("Nextcloud layout under the configured base", () => {
		expect(engine.homePath()).toBe(`/calendars/${NC_USER}/`);
		expect(engine.listPath("work")).toBe(`/calendars/${NC_USER}/work/`);
		expect(engine.objectPath("work", "a b/c")).toBe(
			`/calendars/${NC_USER}/work/a%20b%2Fc.ics`,
		);
	});

	test("quoting matches Python's quote(safe='')", () => {
		// encodeURIComponent leaves !'()* alone; Python escapes them.
		expect(engine.objectPath("l", "x!'()*~._-é")).toBe(
			`/calendars/${NC_USER}/l/x%21%27%28%29%2A~._-%C3%A9.ics`,
		);
	});

	test("ids and UID hints decode the last segment", () => {
		expect(
			CalDAVEngine.listIdFromHref(`${BASE_PATH}/calendars/u/my%20list/`),
		).toBe("my list");
		expect(CalDAVEngine.uidHintFromHref(`${PERSONAL}A%2FB.ics`)).toBe("A/B");
		expect(CalDAVEngine.uidHintFromHref(`${PERSONAL}legacy-name`)).toBe(
			"legacy-name",
		);
		// Malformed escapes decode leniently, like urllib's unquote.
		expect(CalDAVEngine.uidHintFromHref(`${PERSONAL}bad%E2%28.ics`)).toBe(
			"bad�(",
		);
	});

	test("server hrefs are used verbatim; engine paths resolve under the base", async () => {
		await engine.getObject(NC_SIMPLE);
		await engine.getSyncToken("/calendars/viktor-nc/work/");
		expect(fake.requests).toEqual([
			["GET", NC_SIMPLE],
			["PROPFIND", WORK],
		]);
	});

	test("sends Basic auth, Depth and an XML content type", async () => {
		const seen: Request[] = [];
		const spy = engineWith(async (request) => {
			seen.push(request.clone());
			return fake.handler(request);
		});
		await spy.listTaskLists();
		const request = seen[0];
		expect(request?.method).toBe("PROPFIND");
		expect(request?.headers.get("Depth")).toBe("1");
		expect(request?.headers.get("Content-Type")).toBe(
			"application/xml; charset=utf-8",
		);
		expect(request?.headers.get("Authorization")).toBe(
			`Basic ${Buffer.from(`${NC_USER}:${NC_PASS}`).toString("base64")}`,
		);
	});
});

describe("validateCredentials (test_onboarding)", () => {
	test("valid credentials", async () => {
		expect(await engine.validateCredentials()).toBe(true);
	});

	test("wrong password is false, not an error", async () => {
		expect(
			await engineWith(fake.handler, {
				password: "nope",
			}).validateCredentials(),
		).toBe(false);
	});

	test("unknown user is false", async () => {
		const stranger = new CalDAVEngine({
			baseUrl: BASE_URL,
			ncUsername: "ghost",
			appPassword: "x",
			transport: fake.handler,
		});
		expect(await stranger.validateCredentials()).toBe(false);
	});

	test("a non-207 answer is an error", async () => {
		const broken = engineWith(
			async () => new Response("nope", { status: 404 }),
		);
		await expect(broken.validateCredentials()).rejects.toBeInstanceOf(
			CalDAVError,
		);
	});
});

describe("listTaskLists (test_sync lists)", () => {
	test("VTODO-capable calendars only, sorted by id, with names", async () => {
		const lists = await engine.listTaskLists();
		expect(lists).toEqual([
			{
				id: "personal",
				href: PERSONAL,
				name: "Personal",
				order: null,
				sortMode: null,
			},
			{ id: "work", href: WORK, name: "Work", order: null, sortMode: null },
		]);
	});

	test("calendar-order and sort-mode ride along when set", async () => {
		fake.calendar(NC_USER, "work").order = 3;
		fake.calendar(NC_USER, "personal").sortMode = "priority";
		const lists = await engine.listTaskLists();
		expect(lists.map((l) => [l.id, l.order, l.sortMode])).toEqual([
			["personal", null, "priority"],
			["work", 3, null],
		]);
	});

	test.each([
		"alphabetical",
		"",
		"Priority",
		" due ",
	])("a foreign sort-mode %p reads as unset or trimmed", async (value) => {
		fake.calendar(NC_USER, "work").sortMode = value;
		const work = (await engine.listTaskLists()).find((l) => l.id === "work");
		expect(work?.sortMode).toBe(value.trim() === "due" ? "due" : null);
	});

	test("an unparseable calendar-order is null; a missing name falls back to the id", async () => {
		const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
<d:response><d:href>${BASE_PATH}/calendars/u/odd%20one/</d:href><d:propstat><d:prop>
<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname></d:displayname>
<a:calendar-order>first</a:calendar-order></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>${BASE_PATH}/calendars/u/plain/</d:href><d:propstat><d:prop>
<d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
		const odd = engineWith(async () => new Response(body, { status: 207 }));
		expect(await odd.listTaskLists()).toEqual([
			{
				id: "odd one",
				href: `${BASE_PATH}/calendars/u/odd%20one/`,
				name: "odd one",
				order: null,
				sortMode: null,
			},
		]);
	});

	test("a default-namespace multistatus parses the same", async () => {
		const body = `<?xml version="1.0"?>
<multistatus xmlns="DAV:"><response><href>${PERSONAL}</href><propstat><prop>
<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
<displayname>P</displayname><calendar-order xmlns="http://apple.com/ns/ical/">7</calendar-order>
</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
		const other = engineWith(async () => new Response(body, { status: 207 }));
		expect(await other.listTaskLists()).toEqual([
			{ id: "personal", href: PERSONAL, name: "P", order: 7, sortMode: null },
		]);
	});

	test("unparseable XML is a CalDAVError", async () => {
		const bad = engineWith(
			async () => new Response("<d:oops", { status: 207 }),
		);
		await expect(bad.listTaskLists()).rejects.toThrow(
			"unparseable multistatus",
		);
	});
});

describe("list writes (test_ops list_*)", () => {
	test("createList makes a VTODO calendar; a second create is AlreadyExists", async () => {
		await engine.createList("groceries", "Groceries & <stuff>");
		const cal = fake.calendar(NC_USER, "groceries");
		expect(cal.displayname).toBe("Groceries & <stuff>");
		expect([...cal.components]).toEqual(["VTODO"]);
		await expect(
			engine.createList("groceries", "again"),
		).rejects.toBeInstanceOf(CalDAVAlreadyExists);
	});

	test("renameList", async () => {
		await engine.renameList("work", "Office");
		expect(fake.calendar(NC_USER, "work").displayname).toBe("Office");
		await expect(engine.renameList("missing", "x")).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
	});

	test("setListOrder is visible in the next listing", async () => {
		await engine.setListOrder("work", -2);
		await engine.setListOrder("personal", 5);
		const lists = await engine.listTaskLists();
		expect(lists.map((l) => [l.id, l.order])).toEqual([
			["personal", 5],
			["work", -2],
		]);
		await expect(engine.setListOrder("missing", 1)).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
	});

	test("setListSortMode round trips; the engine refuses a value it would not read back", async () => {
		await engine.setListSortMode("work", "due");
		expect(fake.calendar(NC_USER, "work").sortMode).toBe("due");
		const work = (await engine.listTaskLists()).find((l) => l.id === "work");
		expect(work?.sortMode).toBe("due");
		await expect(
			engine.setListSortMode("work", "alphabetical" as SortMode),
		).rejects.toThrow("invalid sort_mode");
		await expect(
			engine.setListSortMode("missing", "due"),
		).rejects.toBeInstanceOf(CalDAVNotFound);
	});

	test("a PROPPATCH propstat that is not 200 is an error", async () => {
		const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href>
<d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat>
</d:response></d:multistatus>`;
		const refusing = engineWith(
			async () => new Response(body, { status: 207 }),
		);
		await expect(refusing.renameList("work", "x")).rejects.toThrow("rejected");
	});

	test("deleteList; a missing list is NotFound", async () => {
		await engine.deleteList("work");
		expect(fake.calendars.get(NC_USER)?.has("work")).toBe(false);
		await expect(engine.deleteList("work")).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
	});
});

describe("sync (test_sync)", () => {
	test("full snapshot: token, then every VTODO with href and ETag", async () => {
		const token = await engine.getSyncToken(PERSONAL);
		expect(token).toBe(`http://fake.local/ns/sync/${NC_USER}/personal/3`);
		const states = await engine.fetchAllTasks(PERSONAL);
		expect(states.map((s) => s.href)).toEqual([
			`${PERSONAL}0D9E1F2A-3B4C-5D6E-7F80-91A2B3C4D5E6.ics`,
			`${PERSONAL}11C0FFEE-AAAA-BBBB-CCCC-000000000001.ics`,
			`${PERSONAL}6FD37E05-9AF0-4C0B-A9E9-D3B0E0F1A2B3.ics`,
		]);
		expect(states.every((s) => /^"etag-\d+"$/.test(s.etag))).toBe(true);
		// calendar-data arrives through XML, which normalises CRLF to LF.
		expect(states[0]?.ics).toBe(
			loadGolden("apple_allday_until.ics").replace(/\r\n/g, "\n"),
		);
	});

	test("a quiet delta is empty and keeps the token", async () => {
		const token = await engine.getSyncToken(WORK);
		const delta = await engine.syncDelta(WORK, token);
		expect(delta).toEqual({ changed: [], removedHrefs: [], syncToken: token });
	});

	test("an external edit, create and delete show up in the delta", async () => {
		const token = await engine.getSyncToken(WORK);
		fake.putIcs(
			NC_USER,
			"work",
			"nc-web-3f2a1b4c5d6e.ics",
			minimalTodo("nc-web-3f2a1b4c5d6e", "Edited"),
		);
		fake.putIcs(NC_USER, "work", "new.ics", minimalTodo("new"));
		fake.deleteIcs(NC_USER, "work", "new.ics");
		fake.putIcs(NC_USER, "work", "LEGACY-NAME.ics", minimalTodo("true-uid"));
		const delta = await engine.syncDelta(WORK, token);
		expect(delta.changed.map((s) => s.href)).toEqual([
			`${WORK}LEGACY-NAME.ics`,
			NC_SIMPLE,
		]);
		expect(delta.changed[1]?.ics).toContain("SUMMARY:Edited");
		expect(delta.removedHrefs).toEqual([`${WORK}new.ics`]);
		expect(delta.syncToken).toBe(`http://fake.local/ns/sync/${NC_USER}/work/5`);
		const again = await engine.syncDelta(WORK, delta.syncToken);
		expect(again.changed).toEqual([]);
		expect(again.removedHrefs).toEqual([]);
	});

	test("an expired or foreign token is CalDAVSyncTokenInvalid", async () => {
		await expect(
			engine.syncDelta(WORK, `http://fake.local/ns/sync/${NC_USER}/work/99`),
		).rejects.toBeInstanceOf(CalDAVSyncTokenInvalid);
		await expect(
			engine.syncDelta(WORK, `http://fake.local/ns/sync/${NC_USER}/personal/1`),
		).rejects.toBeInstanceOf(CalDAVSyncTokenInvalid);
	});

	test("a deleted list is CalDAVNotFound for every sync call", async () => {
		const token = await engine.getSyncToken(WORK);
		await engine.deleteList("work");
		await expect(engine.getSyncToken(WORK)).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
		await expect(engine.fetchAllTasks(WORK)).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
		await expect(engine.syncDelta(WORK, token)).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
	});

	test("unparseable objects are passed through (the sync layer skips them)", async () => {
		fake.putIcs(NC_USER, "work", "junk.ics", "BEGIN:VTODO\r\nnot really ics");
		const states = await engine.fetchAllTasks(WORK);
		expect(states.map((s) => s.href)).toContain(`${WORK}junk.ics`);
	});

	test("multiget skips hrefs the server reports as 404", async () => {
		const states = await engine.multiget(WORK, [NC_SIMPLE, `${WORK}gone.ics`]);
		expect(states.map((s) => s.href)).toEqual([NC_SIMPLE]);
	});

	test("a sync-collection response without a sync-token is an error", async () => {
		const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;
		const bad = engineWith(async () => new Response(body, { status: 207 }));
		await expect(bad.syncDelta(WORK, "t")).rejects.toThrow(
			"lacks a sync-token",
		);
	});
});

describe("objects (test_ops task_*)", () => {
	test("getObject returns the body and ETag; a missing object is NotFound", async () => {
		const state = await engine.getObject(NC_SIMPLE);
		expect(state.href).toBe(NC_SIMPLE);
		expect(state.etag).toBe(
			fake.getObject(NC_USER, "work", "nc-web-3f2a1b4c5d6e.ics").etag,
		);
		expect(state.ics).toBe(loadGolden("nextcloud_simple.ics"));
		await expect(engine.getObject(`${WORK}nope.ics`)).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
	});

	test("create with If-None-Match; the same UID again is PreconditionFailed", async () => {
		const href = engine.objectPath("work", "new-uid");
		await engine.putObject(href, minimalTodo("new-uid"), { ifNoneMatch: true });
		expect(fake.getObject(NC_USER, "work", "new-uid.ics").ics).toBe(
			minimalTodo("new-uid"),
		);
		await expect(
			engine.putObject(href, minimalTodo("new-uid", "Usurper"), {
				ifNoneMatch: true,
			}),
		).rejects.toBeInstanceOf(CalDAVPreconditionFailed);
	});

	test("PUT into a missing list is NotFound", async () => {
		await expect(
			engine.putObject(engine.objectPath("missing", "u"), minimalTodo("u"), {
				ifNoneMatch: true,
			}),
		).rejects.toBeInstanceOf(CalDAVNotFound);
	});

	test("update with If-Match: current tag applies, stale tag is PreconditionFailed", async () => {
		const state = await engine.getObject(NC_SIMPLE);
		await engine.putObject(
			NC_SIMPLE,
			minimalTodo("nc-web-3f2a1b4c5d6e", "v2"),
			{
				ifMatch: state.etag,
			},
		);
		await expect(
			engine.putObject(NC_SIMPLE, minimalTodo("nc-web-3f2a1b4c5d6e", "v3"), {
				ifMatch: state.etag,
			}),
		).rejects.toBeInstanceOf(CalDAVPreconditionFailed);
	});

	test("findTask: the <uid>.ics convention first", async () => {
		const found = await engine.findTask(WORK, "nc-web-3f2a1b4c5d6e");
		expect(found?.href).toBe(NC_SIMPLE);
		expect(fake.requests.map(([m]) => m)).toEqual(["GET"]);
	});

	test("findTask: a foreign filename is found by a UID calendar-query", async () => {
		fake.putIcs(
			NC_USER,
			"work",
			"Apple-Legacy-Name.ics",
			minimalTodo("odd-uid"),
		);
		const found = await engine.findTask(WORK, "odd-uid");
		expect(found?.href).toBe(`${WORK}Apple-Legacy-Name.ics`);
		expect(found?.ics).toContain("UID:odd-uid");
		expect(fake.requests.map(([m]) => m)).toEqual(["GET", "REPORT"]);
	});

	test("findTask: a missing UID is null; a missing list is NotFound", async () => {
		expect(await engine.findTask(WORK, "nope")).toBeNull();
		await expect(
			engine.findTask(`${BASE_PATH}/calendars/${NC_USER}/missing/`, "x"),
		).rejects.toBeInstanceOf(CalDAVNotFound);
	});

	test("deleteObject: current tag deletes, stale tag is PreconditionFailed, missing is NotFound", async () => {
		const state = await engine.getObject(NC_SIMPLE);
		fake.putIcs(
			NC_USER,
			"work",
			"nc-web-3f2a1b4c5d6e.ics",
			minimalTodo("nc-web-3f2a1b4c5d6e"),
		);
		await expect(
			engine.deleteObject(NC_SIMPLE, { ifMatch: state.etag }),
		).rejects.toBeInstanceOf(CalDAVPreconditionFailed);
		const fresh = await engine.getObject(NC_SIMPLE);
		await engine.deleteObject(NC_SIMPLE, { ifMatch: fresh.etag });
		expect(
			fake.calendar(NC_USER, "work").objects.has("nc-web-3f2a1b4c5d6e.ics"),
		).toBe(false);
		await expect(engine.deleteObject(NC_SIMPLE)).rejects.toBeInstanceOf(
			CalDAVNotFound,
		);
	});

	test("an unexpected 4xx is a plain CalDAVError naming the status", async () => {
		const forbidding = engineWith(
			async () => new Response(null, { status: 403 }),
		);
		const err = await forbidding
			.putObject(NC_SIMPLE, "x")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CalDAVError);
		expect(err).not.toBeInstanceOf(CalDAVTransient);
		expect(String(err)).toContain("HTTP 403");
	});
});

describe("upstream failures (test_ops retry)", () => {
	test("401 on a data call is CalDAVUnauthorized", async () => {
		const stale = engineWith(fake.handler, { password: "rotated" });
		await expect(stale.listTaskLists()).rejects.toBeInstanceOf(
			CalDAVUnauthorized,
		);
	});

	test.each([
		500, 502, 503, 504,
	])("HTTP %d is CalDAVTransient", async (status) => {
		const flaky = engineWith(async () => new Response("boom", { status }));
		await expect(flaky.putObject(NC_SIMPLE, "x")).rejects.toBeInstanceOf(
			CalDAVTransient,
		);
	});

	test("a transport error is CalDAVTransient", async () => {
		const down = engineWith(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(down.getObject(NC_SIMPLE)).rejects.toBeInstanceOf(
			CalDAVTransient,
		);
	});

	test("a timeout is CalDAVTransient", async () => {
		const slow = engineWith(
			(request) =>
				new Promise<Response>((_, reject) => {
					request.signal.addEventListener("abort", () =>
						reject(request.signal.reason),
					);
				}),
			{ timeoutMs: 20 },
		);
		const err = await slow.getObject(NC_SIMPLE).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CalDAVTransient);
		expect(String(err)).toContain("upstream timed out");
	});
});

// ---------------------------------------------------------------- the edge

/**
 * Port of backend/tests/test_edge_conditionals.py, at the engine level.
 *
 * Discovered live on 2026-07-03 against nextcloud.viktorbarzin.me: the
 * ingress answers conditional WRITES itself and never forwards them
 * upstream: PUT with `If-None-Match: *` gets an empty 304 (a status RFC 9110
 * §15.4.5 reserves for GET/HEAD), and PUT/DELETE with `If-Match` gets a
 * blanket 412, even when the tag matches. The engine detects both and
 * degrades to verify-then-retry. Against a compliant server the fallback
 * never engages; the rest of this file pins that.
 */
function brokenEdge(target: FakeNextcloud): CalDAVTransport {
	return async (request) => {
		if (
			request.method === "PUT" &&
			request.headers.get("If-None-Match") === "*"
		) {
			return new Response(null, { status: 304 });
		}
		if (
			(request.method === "PUT" || request.method === "DELETE") &&
			request.headers.has("If-Match")
		) {
			return new Response(null, { status: 412 });
		}
		return target.handler(request);
	};
}

describe("broken edge (test_edge_conditionals)", () => {
	let edge: CalDAVEngine;
	beforeEach(() => {
		edge = engineWith(brokenEdge(fake));
	});

	test("create applies through the broken edge", async () => {
		const href = edge.objectPath("work", "edge-uid-1");
		await edge.putObject(href, minimalTodo("edge-uid-1", "Through the edge"), {
			ifNoneMatch: true,
		});
		expect(fake.getObject(NC_USER, "work", "edge-uid-1.ics").ics).toContain(
			"SUMMARY:Through the edge",
		);
	});

	test("creating an existing UID is still PreconditionFailed (ops: duplicate)", async () => {
		const href = edge.objectPath("work", "edge-uid-1");
		await edge.putObject(href, minimalTodo("edge-uid-1", "First wins"), {
			ifNoneMatch: true,
		});
		await expect(
			edge.putObject(href, minimalTodo("edge-uid-1", "Usurper"), {
				ifNoneMatch: true,
			}),
		).rejects.toBeInstanceOf(CalDAVPreconditionFailed);
		expect(fake.getObject(NC_USER, "work", "edge-uid-1.ics").ics).toContain(
			"SUMMARY:First wins",
		);
	});

	test("an update with the current tag applies through the broken edge", async () => {
		const state = await edge.getObject(NC_SIMPLE);
		await edge.putObject(
			NC_SIMPLE,
			minimalTodo("nc-web-3f2a1b4c5d6e", "Edited"),
			{
				ifMatch: state.etag,
			},
		);
		expect(
			fake.getObject(NC_USER, "work", "nc-web-3f2a1b4c5d6e.ics").ics,
		).toContain("SUMMARY:Edited");
	});

	test("a genuinely stale tag stays a 412 (the ops LWW loop re-applies)", async () => {
		const filename = "nc-web-3f2a1b4c5d6e.ics";
		fake.addAfterGetHook(filename, () => {
			const current = fake.getObject(NC_USER, "work", filename);
			const edited = current.ics.replace(
				"SUMMARY:Ring insurer about policy renewal",
				"SUMMARY:Renamed elsewhere",
			);
			expect(edited).not.toBe(current.ics); // the seed summary moved: update this test
			fake.putIcs(NC_USER, "work", filename, edited);
		});
		const state = await edge.getObject(NC_SIMPLE); // the hook edits right after
		await expect(
			edge.putObject(NC_SIMPLE, minimalTodo("nc-web-3f2a1b4c5d6e", "mine"), {
				ifMatch: state.etag,
			}),
		).rejects.toBeInstanceOf(CalDAVPreconditionFailed);
		expect(fake.getObject(NC_USER, "work", filename).ics).toContain(
			"SUMMARY:Renamed elsewhere",
		);
	});

	test("an update of a vanished object through the edge is NotFound", async () => {
		const state = await edge.getObject(NC_SIMPLE);
		fake.deleteIcs(NC_USER, "work", "nc-web-3f2a1b4c5d6e.ics");
		await expect(
			edge.putObject(NC_SIMPLE, "x", { ifMatch: state.etag }),
		).rejects.toBeInstanceOf(CalDAVNotFound);
	});

	test("delete applies through the broken edge", async () => {
		const state = await edge.getObject(NC_SIMPLE);
		await edge.deleteObject(NC_SIMPLE, { ifMatch: state.etag });
		expect(
			fake.calendar(NC_USER, "work").objects.has("nc-web-3f2a1b4c5d6e.ics"),
		).toBe(false);
	});

	test("delete with a stale tag through the edge is PreconditionFailed", async () => {
		const state = await edge.getObject(NC_SIMPLE);
		fake.putIcs(
			NC_USER,
			"work",
			"nc-web-3f2a1b4c5d6e.ics",
			minimalTodo("nc-web-3f2a1b4c5d6e"),
		);
		await expect(
			edge.deleteObject(NC_SIMPLE, { ifMatch: state.etag }),
		).rejects.toBeInstanceOf(CalDAVPreconditionFailed);
	});

	test("an edge that kills every PUT surfaces an error naming 304, never loops", async () => {
		const hostile = engineWith(async (request) =>
			request.method === "PUT"
				? new Response(null, { status: 304 })
				: fake.handler(request),
		);
		const err = await hostile
			.putObject(
				hostile.objectPath("work", "edge-uid-1"),
				minimalTodo("edge-uid-1"),
				{
					ifNoneMatch: true,
				},
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CalDAVError);
		expect(String(err)).toContain("304");
		const puts = fake.requests.filter(([m]) => m === "PUT");
		expect(puts).toEqual([]); // the fake never saw a PUT: both died at the "edge"
	});

	test("against a compliant server the fallback never engages", async () => {
		const state = await engine.getObject(NC_SIMPLE);
		await engine.putObject(NC_SIMPLE, minimalTodo("nc-web-3f2a1b4c5d6e"), {
			ifMatch: state.etag,
		});
		expect(fake.requests.map(([m]) => m)).toEqual(["GET", "PUT"]);
	});
});
