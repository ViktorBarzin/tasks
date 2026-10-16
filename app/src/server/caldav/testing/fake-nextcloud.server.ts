/**
 * An in-memory Nextcloud/sabre CalDAV double. Port of
 * backend/tests/fake_caldav.py; pass `fake.handler` as the engine's
 * `transport` (the Python suite wrapped it in httpx.MockTransport).
 *
 * It implements just enough DAV for the backend: Basic auth, principal
 * PROPFIND, calendar-home PROPFIND, sync-collection / calendar-query /
 * calendar-multiget REPORTs, object GET/PUT/DELETE with ETag preconditions,
 * MKCALENDAR and PROPPATCH. Sync-tokens follow sabre's monotonic-counter
 * style and are validated, so expired or foreign tokens 403 exactly like
 * production.
 *
 * Test hooks:
 * - `addAfterGetHook(filename, fn)`: run `fn` once after the next GET of that
 *   object (inject a concurrent edit between an engine's GET and PUT to force
 *   the 412 / silent-LWW path).
 * - `putIcs` / `deleteIcs` / `getObject`: mutate or read state directly, as
 *   "another client" (Apple, Nextcloud web) would.
 * - `calendar(user, id)`: the calendar record, e.g. to set `order` or
 *   `sortMode` the way another client's PROPPATCH would.
 * - `requests`: the (method, decoded path) audit trail.
 *
 * Like httpx's `URL.path`, request paths are percent-decoded before routing,
 * and hrefs in responses carry the stored filename unencoded.
 */
import type { CalDAVTransport } from "../engine.server";
import {
	escapeXml,
	find,
	findAll,
	parseXml,
	type Step,
	type XmlElement,
} from "../xml.server";

export const BASE_PATH = "/remote.php/dav";

const NS = {
	d: "DAV:",
	c: "urn:ietf:params:xml:ns:caldav",
	a: "http://apple.com/ns/ical/",
	vb: "urn:viktorbarzin:tasks",
} as const;
const d = (name: string, deep = false): Step => ({ ns: NS.d, name, deep });
const c = (name: string, deep = false): Step => ({ ns: NS.c, name, deep });

export interface FakeObject {
	ics: string;
	etag: string;
}

export class FakeCalendar {
	displayname: string;
	components: ReadonlySet<string>;
	/** Apple calendar-order; null = unset (like a fresh Nextcloud calendar). */
	order: number | null = null;
	/**
	 * This app's `{urn:viktorbarzin:tasks}sort-mode` dead property. The real
	 * sabre stores ANY string a PROPPATCH sends (validation is app-side), so
	 * the fake does too. null = unset.
	 */
	sortMode: string | null = null;
	objects = new Map<string, FakeObject>();
	version = 0;
	/** filename -> [version at last change, deleted?] */
	changes = new Map<string, [number, boolean]>();

	constructor(displayname: string, components: Iterable<string>) {
		this.displayname = displayname;
		this.components = new Set(components);
	}

	bump(filename: string, deleted: boolean): void {
		this.version += 1;
		this.changes.set(filename, [this.version, deleted]);
	}
}

function response(
	status: number,
	body: string | null = null,
	headers: Record<string, string> = {},
): Response {
	return new Response(body, { status, headers });
}

function xml(status: number, body: string): Response {
	return response(status, body, {
		"Content-Type": "application/xml; charset=utf-8",
	});
}

/** Python's sorted() on str keys: by code point. */
function byCodePoint(a: string, b: string): number {
	const ac = [...a].map((ch) => ch.codePointAt(0) ?? 0);
	const bc = [...b].map((ch) => ch.codePointAt(0) ?? 0);
	for (let i = 0; i < Math.min(ac.length, bc.length); i++) {
		const diff = (ac[i] ?? 0) - (bc[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return ac.length - bc.length;
}

function percentDecode(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

export class FakeNextcloud {
	readonly users = new Map<string, string>();
	readonly calendars = new Map<string, Map<string, FakeCalendar>>();
	/** (method, path) audit trail. */
	readonly requests: [string, string][] = [];
	private etagCounter = 0;
	private readonly afterGetHooks = new Map<string, () => void>();

	// -- state manipulation (tests act as "another client")

	addUser(username: string, password: string): void {
		this.users.set(username, password);
		if (!this.calendars.has(username)) this.calendars.set(username, new Map());
	}

	addCalendar(
		username: string,
		calId: string,
		displayname: string,
		components: Iterable<string> = ["VTODO"],
	): void {
		this.userCalendars(username).set(
			calId,
			new FakeCalendar(displayname, components),
		);
	}

	calendar(username: string, calId: string): FakeCalendar {
		const cal = this.userCalendars(username).get(calId);
		if (cal === undefined) throw new Error(`no calendar ${username}/${calId}`);
		return cal;
	}

	private userCalendars(username: string): Map<string, FakeCalendar> {
		const cals = this.calendars.get(username);
		if (cals === undefined) throw new Error(`no user ${username}`);
		return cals;
	}

	private nextEtag(): string {
		this.etagCounter += 1;
		return `"etag-${this.etagCounter}"`;
	}

	putIcs(username: string, calId: string, filename: string, ics: string): void {
		const cal = this.calendar(username, calId);
		cal.objects.set(filename, { ics, etag: this.nextEtag() });
		cal.bump(filename, false);
	}

	deleteIcs(username: string, calId: string, filename: string): void {
		const cal = this.calendar(username, calId);
		if (!cal.objects.delete(filename)) {
			throw new Error(`no object ${username}/${calId}/${filename}`);
		}
		cal.bump(filename, true);
	}

	getObject(username: string, calId: string, filename: string): FakeObject {
		const obj = this.calendar(username, calId).objects.get(filename);
		if (obj === undefined) {
			throw new Error(`no object ${username}/${calId}/${filename}`);
		}
		return obj;
	}

	addAfterGetHook(filename: string, hook: () => void): void {
		this.afterGetHooks.set(filename, hook);
	}

	// -- helpers

	private static calHref(username: string, calId: string): string {
		return `${BASE_PATH}/calendars/${username}/${calId}/`;
	}

	private static syncToken(username: string, calId: string, version: number) {
		return `http://fake.local/ns/sync/${username}/${calId}/${version}`;
	}

	private parseSyncToken(
		token: string,
		username: string,
		calId: string,
	): number | null {
		const prefix = `http://fake.local/ns/sync/${username}/${calId}/`;
		if (!token.startsWith(prefix)) return null;
		const rest = token.slice(prefix.length).trim();
		// Python's int(): optional sign, digits, underscores between digits.
		if (!/^[+-]?\d+(_\d+)*$/.test(rest)) return null;
		const version = Number(rest.replace(/_/g, ""));
		if (version > this.calendar(username, calId).version) return null;
		return version;
	}

	private authedUser(request: Request): string | null {
		const header = request.headers.get("Authorization") ?? "";
		if (!header.startsWith("Basic ")) return null;
		let decoded: string;
		try {
			const bytes = Buffer.from(header.slice(6), "base64");
			decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return null;
		}
		const colon = decoded.indexOf(":");
		const username = colon === -1 ? decoded : decoded.slice(0, colon);
		const password = colon === -1 ? "" : decoded.slice(colon + 1);
		if (this.users.get(username) !== password) return null;
		return username;
	}

	// -- the transport

	/** The fake's request handler; pass it as the engine's transport. */
	readonly handler: CalDAVTransport = async (request) => {
		const path = percentDecode(new URL(request.url).pathname);
		this.requests.push([request.method, path]);
		if (!path.startsWith(BASE_PATH)) return response(404);
		const user = this.authedUser(request);
		if (user === null) return response(401, "Unauthorised");

		const rel = path.slice(BASE_PATH.length).replace(/\/+$/, "");
		const segments = rel.split("/").filter((s) => s !== "");
		const content = await request.text();

		switch (request.method) {
			case "PROPFIND":
				return this.propfind(user, segments);
			case "REPORT":
				return this.report(content, user, segments);
			case "MKCALENDAR":
				return this.mkcalendar(content, user, segments);
			case "PROPPATCH":
				return this.proppatch(content, user, segments);
			case "GET":
				return this.get(user, segments);
			case "PUT":
				return this.put(request, content, user, segments);
			case "DELETE":
				return this.delete(request, user, segments);
			default:
				return response(405);
		}
	};

	// -- PROPFIND

	private propfind(user: string, segments: string[]): Response {
		if (segments.length === 0) {
			// DAV root: principal discovery
			const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>${BASE_PATH}/</d:href><d:propstat><d:prop>
  <d:current-user-principal><d:href>${BASE_PATH}/principals/users/${escapeXml(user)}/</d:href></d:current-user-principal>
 </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
			return xml(207, body);
		}

		if (segments.length === 2 && segments[0] === "calendars") {
			const owner = segments[1] ?? "";
			if (owner !== user) return response(403);
			const responses = [
				`<d:response><d:href>${BASE_PATH}/calendars/${escapeXml(owner)}/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
			];
			for (const [calId, cal] of this.userCalendars(owner)) {
				const comps = [...cal.components]
					.sort(byCodePoint)
					.map((comp) => `<c:comp name="${escapeXml(comp)}"/>`)
					.join("");
				// sabre reports unset properties under a 404 propstat (empty
				// elements); set ones ride in the 200 block. Verified live for
				// both calendar-order and the custom sort-mode dead property.
				let setXml = "";
				let unsetXml = "";
				if (cal.order !== null) {
					setXml += `\n <a:calendar-order>${cal.order}</a:calendar-order>`;
				} else {
					unsetXml += "<a:calendar-order/>";
				}
				if (cal.sortMode !== null) {
					setXml += `\n <vb:sort-mode>${escapeXml(cal.sortMode)}</vb:sort-mode>`;
				} else {
					unsetXml += "<vb:sort-mode/>";
				}
				const notFound = unsetXml
					? `<d:propstat><d:prop>${unsetXml}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`
					: "";
				responses.push(
					`<d:response><d:href>${FakeNextcloud.calHref(owner, calId)}</d:href>
<d:propstat><d:prop>
 <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
 <d:displayname>${escapeXml(cal.displayname)}</d:displayname>${setXml}
 <c:supported-calendar-component-set>${comps}</c:supported-calendar-component-set>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${notFound}</d:response>`,
				);
			}
			const body =
				'<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" ' +
				'xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" ' +
				'xmlns:vb="urn:viktorbarzin:tasks">' +
				responses.join("") +
				"</d:multistatus>";
			return xml(207, body);
		}

		if (segments.length === 3 && segments[0] === "calendars") {
			const owner = segments[1] ?? "";
			const calId = segments[2] ?? "";
			if (owner !== user) return response(403);
			const calendar = this.userCalendars(owner).get(calId);
			if (calendar === undefined) return response(404);
			const token = FakeNextcloud.syncToken(owner, calId, calendar.version);
			const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>${FakeNextcloud.calHref(owner, calId)}</d:href><d:propstat><d:prop>
  <d:sync-token>${escapeXml(token)}</d:sync-token>
  <d:displayname>${escapeXml(calendar.displayname)}</d:displayname>
 </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
			return xml(207, body);
		}

		return response(404);
	}

	// -- REPORT

	private report(content: string, user: string, segments: string[]): Response {
		if (segments.length !== 3 || segments[0] !== "calendars") {
			return response(404);
		}
		const owner = segments[1] ?? "";
		const calId = segments[2] ?? "";
		if (owner !== user) return response(403);
		const cal = this.userCalendars(owner).get(calId);
		if (cal === undefined) return response(404);
		let root: XmlElement;
		try {
			root = parseXml(content);
		} catch {
			return response(400);
		}
		if (root.ns === NS.d && root.name === "sync-collection") {
			return this.reportSync(root, owner, calId, cal);
		}
		if (root.ns === NS.c && root.name === "calendar-query") {
			return this.reportQuery(root, owner, calId, cal);
		}
		if (root.ns === NS.c && root.name === "calendar-multiget") {
			return this.reportMultiget(root, owner, calId, cal);
		}
		return response(400);
	}

	private static objectResponse(
		owner: string,
		calId: string,
		filename: string,
		obj: FakeObject,
	): string {
		return `<d:response><d:href>${FakeNextcloud.calHref(owner, calId)}${escapeXml(filename)}</d:href>
<d:propstat><d:prop><d:getetag>${escapeXml(obj.etag)}</d:getetag>
<c:calendar-data>${escapeXml(obj.ics)}</c:calendar-data>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
	}

	private reportSync(
		root: XmlElement,
		owner: string,
		calId: string,
		cal: FakeCalendar,
	): Response {
		const tokenText = (find(root, [d("sync-token")])?.text ?? "").trim();
		const since = tokenText ? this.parseSyncToken(tokenText, owner, calId) : 0;
		if (since === null) {
			// sabre: 403 + DAV:valid-sync-token precondition
			return xml(
				403,
				'<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',
			);
		}
		const responses: string[] = [];
		const filenames = [...cal.changes.keys()].sort(byCodePoint);
		for (const filename of filenames) {
			const [version, deleted] = cal.changes.get(filename) ?? [0, false];
			if (version <= since) continue;
			const href = `${FakeNextcloud.calHref(owner, calId)}${escapeXml(filename)}`;
			if (deleted) {
				responses.push(
					`<d:response><d:href>${href}</d:href>` +
						"<d:status>HTTP/1.1 404 Not Found</d:status></d:response>",
				);
			} else {
				const obj = cal.objects.get(filename);
				responses.push(
					`<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
						`<d:getetag>${escapeXml(obj?.etag ?? "")}</d:getetag></d:prop>` +
						"<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
				);
			}
		}
		const newToken = FakeNextcloud.syncToken(owner, calId, cal.version);
		const body =
			'<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:">' +
			responses.join("") +
			`<d:sync-token>${escapeXml(newToken)}</d:sync-token></d:multistatus>`;
		return xml(207, body);
	}

	private static hasUid(ics: string, uid: string): boolean {
		const unfolded = ics.replace(/\r\n /g, "").replace(/\r\n\t/g, "");
		return unfolded
			.replace(/\r\n/g, "\n")
			.split("\n")
			.map((line) => line.trim())
			.includes(`UID:${uid}`);
	}

	private reportQuery(
		root: XmlElement,
		owner: string,
		calId: string,
		cal: FakeCalendar,
	): Response {
		let uidFilter: string | null = null;
		const vtodoFilters = findAll(root, [c("comp-filter", true)]).filter(
			(el) => el.attributes.name === "VTODO",
		);
		for (const filter of vtodoFilters) {
			const propFilter = filter.children.find(
				(el) =>
					el.ns === NS.c &&
					el.name === "prop-filter" &&
					el.attributes.name === "UID",
			);
			const match = propFilter && find(propFilter, [c("text-match")]);
			if (match) {
				uidFilter = match.text.trim();
				break;
			}
		}
		const responses: string[] = [];
		for (const filename of [...cal.objects.keys()].sort(byCodePoint)) {
			const obj = cal.objects.get(filename);
			if (obj === undefined || !obj.ics.includes("BEGIN:VTODO")) continue;
			if (uidFilter !== null && !FakeNextcloud.hasUid(obj.ics, uidFilter)) {
				continue;
			}
			responses.push(FakeNextcloud.objectResponse(owner, calId, filename, obj));
		}
		const body =
			'<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" ' +
			'xmlns:c="urn:ietf:params:xml:ns:caldav">' +
			responses.join("") +
			"</d:multistatus>";
		return xml(207, body);
	}

	private reportMultiget(
		root: XmlElement,
		owner: string,
		calId: string,
		cal: FakeCalendar,
	): Response {
		const responses: string[] = [];
		for (const hrefEl of findAll(root, [d("href")])) {
			const href = hrefEl.text.trim();
			const filename = href.replace(/\/+$/, "").split("/").at(-1) ?? "";
			const obj = cal.objects.get(filename);
			if (obj === undefined) {
				responses.push(
					`<d:response><d:href>${escapeXml(href)}</d:href>` +
						"<d:status>HTTP/1.1 404 Not Found</d:status></d:response>",
				);
			} else {
				responses.push(
					FakeNextcloud.objectResponse(owner, calId, filename, obj),
				);
			}
		}
		const body =
			'<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" ' +
			'xmlns:c="urn:ietf:params:xml:ns:caldav">' +
			responses.join("") +
			"</d:multistatus>";
		return xml(207, body);
	}

	// -- collection and object methods

	private mkcalendar(
		content: string,
		user: string,
		segments: string[],
	): Response {
		if (
			segments.length !== 3 ||
			segments[0] !== "calendars" ||
			segments[1] !== user
		) {
			return response(403);
		}
		const calId = segments[2] ?? "";
		if (this.userCalendars(user).has(calId)) return response(405);
		let displayname = calId;
		if (content) {
			try {
				const nameEl = find(parseXml(content), [d("displayname", true)]);
				if (nameEl?.text) displayname = nameEl.text;
			} catch {
				return response(400);
			}
		}
		this.addCalendar(user, calId, displayname);
		return response(201);
	}

	private proppatch(
		content: string,
		user: string,
		segments: string[],
	): Response {
		if (
			segments.length !== 3 ||
			segments[0] !== "calendars" ||
			segments[1] !== user
		) {
			return response(403);
		}
		const calId = segments[2] ?? "";
		const cal = this.userCalendars(user).get(calId);
		if (cal === undefined) return response(404);
		let root: XmlElement;
		try {
			root = parseXml(content);
		} catch {
			return response(400);
		}
		const setProp = (ns: string, name: string) =>
			find(root, [d("set", true), d("prop"), { ns, name }]);
		const setProps: string[] = [];
		const nameEl = setProp(NS.d, "displayname");
		if (nameEl !== null) {
			cal.displayname = nameEl.text;
			setProps.push("<d:displayname/>");
		}
		const orderEl = setProp(NS.a, "calendar-order");
		if (orderEl !== null) {
			const raw = orderEl.text.trim();
			if (!/^[+-]?\d+$/.test(raw)) return response(400);
			cal.order = Number(raw);
			setProps.push("<a:calendar-order/>");
		}
		const sortModeEl = setProp(NS.vb, "sort-mode");
		if (sortModeEl !== null) {
			// A dead property: sabre stores whatever string arrives (verified
			// live); value validation is the app server's job, not DAV's.
			cal.sortMode = sortModeEl.text;
			setProps.push("<vb:sort-mode/>");
		}
		if (setProps.length === 0) return response(400);
		const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/" xmlns:vb="urn:viktorbarzin:tasks">
 <d:response><d:href>${FakeNextcloud.calHref(user, calId)}</d:href>
  <d:propstat><d:prop>${setProps.join("")}</d:prop>
  <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
		return xml(207, body);
	}

	private locate(
		user: string,
		segments: string[],
	): [string, FakeCalendar, string] | Response {
		if (segments.length !== 4 || segments[0] !== "calendars") {
			return response(404);
		}
		if (segments[1] !== user) return response(403);
		const calId = segments[2] ?? "";
		const cal = this.userCalendars(user).get(calId);
		if (cal === undefined) return response(404);
		return [calId, cal, segments[3] ?? ""];
	}

	private get(user: string, segments: string[]): Response {
		const located = this.locate(user, segments);
		if (located instanceof Response) return located;
		const [, cal, filename] = located;
		const obj = cal.objects.get(filename);
		if (obj === undefined) return response(404);
		const result = response(200, obj.ics, {
			ETag: obj.etag,
			"Content-Type": "text/calendar; charset=utf-8",
		});
		const hook = this.afterGetHooks.get(filename);
		if (hook !== undefined) {
			this.afterGetHooks.delete(filename);
			hook();
		}
		return result;
	}

	private put(
		request: Request,
		content: string,
		user: string,
		segments: string[],
	): Response {
		const located = this.locate(user, segments);
		if (located instanceof Response) return located;
		const [calId, cal, filename] = located;
		const existing = cal.objects.get(filename);
		if (
			request.headers.get("If-None-Match") === "*" &&
			existing !== undefined
		) {
			return response(412);
		}
		const ifMatch = request.headers.get("If-Match");
		if (
			ifMatch !== null &&
			(existing === undefined || existing.etag !== ifMatch)
		) {
			return response(412);
		}
		this.putIcs(user, calId, filename, content);
		return response(existing === undefined ? 201 : 204, null, {
			ETag: cal.objects.get(filename)?.etag ?? "",
		});
	}

	private delete(request: Request, user: string, segments: string[]): Response {
		// collection delete
		if (
			segments.length === 3 &&
			segments[0] === "calendars" &&
			segments[1] === user
		) {
			const cals = this.userCalendars(user);
			if (!cals.delete(segments[2] ?? "")) return response(404);
			return response(204);
		}
		const located = this.locate(user, segments);
		if (located instanceof Response) return located;
		const [calId, cal, filename] = located;
		const existing = cal.objects.get(filename);
		if (existing === undefined) return response(404);
		const ifMatch = request.headers.get("If-Match");
		if (ifMatch !== null && existing.etag !== ifMatch) return response(412);
		this.deleteIcs(user, calId, filename);
		return response(204);
	}
}
