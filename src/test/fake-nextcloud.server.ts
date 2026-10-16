/**
 * Test doubles for the /api layer: an in-memory Nextcloud seen through the
 * CalDAV engine's interface, and a tiny VTODO mapper.
 *
 * The Python suite drove the real engine against backend/tests/fake_caldav.py
 * over httpx.MockTransport. The ops and sync layers only see the engine's
 * methods, so this double models FakeNextcloud's state one level up: the same
 * calendars, ETags, sabre-style sync tokens, after-GET hooks and the same
 * CalDAV errors the real engine raises. Tests that need the DAV wire format
 * (the openresty edge quirks, XML parsing) belong to the engine's own suite.
 *
 * `fakeMapper` stands in for src/server/caldav/ics.server.ts with a plain
 * `NAME:value` line format (no folding, no timezones), enough to observe
 * which fields an op touched and that untouched ones survive. It is not ICS.
 */
import type { Priority, SortMode } from "#/shared/contract";
import { SORT_MODES } from "#/shared/contract";
import {
	CalDAVAlreadyExists,
	CalDAVNotFound,
	CalDAVPreconditionFailed,
	CalDAVSyncTokenInvalid,
	CalDAVUnauthorized,
	type DeleteOptions,
	type DeltaResult,
	type ListInfo,
	type ObjectState,
	type PutOptions,
} from "../server/caldav/engine.server";
import {
	MapperError,
	type OpTaskFields,
	type ParsedTask,
} from "../server/caldav/ics.server";

export const BASE_PATH = "/remote.php/dav";

export interface FakeObject {
	ics: string;
	etag: string;
}

export interface FakeCalendar {
	displayname: string;
	components: ReadonlySet<string>;
	order: number | null;
	/** Any string, like sabre's dead property; the engine filters it. */
	sortMode: string | null;
	objects: Map<string, FakeObject>;
	version: number;
	/** filename -> [version at last change, deleted?] */
	changes: Map<string, [number, boolean]>;
}

/** The DAV method a real engine call would send, for fault injection and audit. */
export type DavMethod =
	| "PROPFIND"
	| "REPORT"
	| "GET"
	| "PUT"
	| "DELETE"
	| "MKCALENDAR"
	| "PROPPATCH";

/** Return an Error to make that call throw it (e.g. CalDAVTransient). */
export type FaultHook = (method: DavMethod, path: string) => Error | undefined;

export class FakeNextcloud {
	readonly users = new Map<string, string>();
	readonly calendars = new Map<string, Map<string, FakeCalendar>>();
	/** (method, path) audit trail, paths with BASE_PATH. */
	readonly requests: Array<[DavMethod, string]> = [];
	fault: FaultHook | undefined;
	private etagCounter = 0;
	private readonly afterGetHooks = new Map<string, () => void>();

	addUser(username: string, password: string): void {
		this.users.set(username, password);
		if (!this.calendars.has(username)) this.calendars.set(username, new Map());
	}

	addCalendar(
		username: string,
		calId: string,
		displayname: string,
		components: string[] = ["VTODO"],
	): void {
		this.userCalendars(username).set(calId, {
			displayname,
			components: new Set(components),
			order: null,
			sortMode: null,
			objects: new Map(),
			version: 0,
			changes: new Map(),
		});
	}

	calendar(username: string, calId: string): FakeCalendar {
		const cal = this.userCalendars(username).get(calId);
		if (!cal) throw new Error(`no calendar ${calId}`);
		return cal;
	}

	putIcs(username: string, calId: string, filename: string, ics: string): void {
		const cal = this.calendar(username, calId);
		cal.objects.set(filename, { ics, etag: this.nextEtag() });
		bump(cal, filename, false);
	}

	deleteIcs(username: string, calId: string, filename: string): void {
		const cal = this.calendar(username, calId);
		cal.objects.delete(filename);
		bump(cal, filename, true);
	}

	getObject(username: string, calId: string, filename: string): FakeObject {
		const obj = this.calendar(username, calId).objects.get(filename);
		if (!obj) throw new Error(`no object ${calId}/${filename}`);
		return obj;
	}

	/** Run `hook` once, right after the next GET of `filename`. */
	addAfterGetHook(filename: string, hook: () => void): void {
		this.afterGetHooks.set(filename, hook);
	}

	/** An engine authenticated with these credentials. */
	engine(ncUsername: string, appPassword: string): FakeEngine {
		return new FakeEngine(this, ncUsername, appPassword);
	}

	// -- used by FakeEngine

	userCalendars(username: string): Map<string, FakeCalendar> {
		let cals = this.calendars.get(username);
		if (!cals) {
			cals = new Map();
			this.calendars.set(username, cals);
		}
		return cals;
	}

	nextEtag(): string {
		this.etagCounter += 1;
		return `"etag-${this.etagCounter}"`;
	}

	runAfterGetHook(filename: string): void {
		const hook = this.afterGetHooks.get(filename);
		if (hook) {
			this.afterGetHooks.delete(filename);
			hook();
		}
	}

	static syncToken(username: string, calId: string, version: number): string {
		return `http://fake.local/ns/sync/${username}/${calId}/${version}`;
	}
}

function bump(cal: FakeCalendar, filename: string, deleted: boolean): void {
	cal.version += 1;
	cal.changes.set(filename, [cal.version, deleted]);
}

/** `/remote.php/dav/calendars/u/list/x.ics` or `/calendars/u/list/x.ics` -> segments. */
function segmentsOf(path: string): string[] {
	const rel = path.startsWith(BASE_PATH) ? path.slice(BASE_PATH.length) : path;
	return rel
		.split("/")
		.filter(Boolean)
		.map((s) => decodeURIComponent(s));
}

/** Implements the slice of CalDAVEngine that ops, sync and onboarding use. */
export class FakeEngine {
	constructor(
		private readonly nc: FakeNextcloud,
		readonly ncUsername: string,
		private readonly appPassword: string,
	) {}

	closed = false;

	async close(): Promise<void> {
		this.closed = true;
	}

	objectPath(listId: string, uid: string): string {
		return `/calendars/${encodeURIComponent(this.ncUsername)}/${encodeURIComponent(listId)}/${encodeURIComponent(uid)}.ics`;
	}

	private listHref(listId: string): string {
		return `${BASE_PATH}/calendars/${this.ncUsername}/${listId}/`;
	}

	/** Auth, audit and fault injection, as every DAV request would see them. */
	private enter(method: DavMethod, path: string): void {
		const full = path.startsWith(BASE_PATH) ? path : `${BASE_PATH}${path}`;
		this.nc.requests.push([method, full]);
		const injected = this.nc.fault?.(method, full);
		if (injected) throw injected;
		if (this.nc.users.get(this.ncUsername) !== this.appPassword) {
			throw new CalDAVUnauthorized(
				`${method} ${path}: Nextcloud rejected the credentials`,
			);
		}
	}

	private calendarAt(path: string): [string, FakeCalendar] {
		const [, owner, calId] = segmentsOf(path);
		const cal =
			owner === this.ncUsername && calId !== undefined
				? this.nc.userCalendars(owner).get(calId)
				: undefined;
		if (!cal || calId === undefined) {
			throw new CalDAVNotFound(`list '${path}' not found`);
		}
		return [calId, cal];
	}

	private objectAt(path: string): [string, FakeCalendar, string] {
		const segs = segmentsOf(path);
		const filename = segs[3];
		const [calId, cal] = this.calendarAt(path);
		if (filename === undefined) throw new CalDAVNotFound(`object '${path}'`);
		return [calId, cal, filename];
	}

	private state(calId: string, filename: string, obj: FakeObject): ObjectState {
		return {
			href: `${this.listHref(calId)}${filename}`,
			etag: obj.etag,
			ics: obj.ics,
		};
	}

	async validateCredentials(): Promise<boolean> {
		try {
			this.enter("PROPFIND", "/");
		} catch (err) {
			if (err instanceof CalDAVUnauthorized) return false;
			throw err;
		}
		return true;
	}

	async listTaskLists(): Promise<ListInfo[]> {
		this.enter("PROPFIND", `/calendars/${this.ncUsername}/`);
		const lists: ListInfo[] = [];
		for (const [id, cal] of this.nc.userCalendars(this.ncUsername)) {
			if (!cal.components.has("VTODO")) continue;
			lists.push({
				id,
				href: this.listHref(id),
				name: cal.displayname,
				order: cal.order,
				sortMode: SORT_MODES.includes(cal.sortMode as SortMode)
					? (cal.sortMode as SortMode)
					: null,
			});
		}
		return lists.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	async createList(listId: string, name: string): Promise<void> {
		this.enter("MKCALENDAR", this.listHref(listId));
		if (this.nc.userCalendars(this.ncUsername).has(listId)) {
			throw new CalDAVAlreadyExists(`list '${listId}' already exists`);
		}
		this.nc.addCalendar(this.ncUsername, listId, name);
	}

	private proppatch(listId: string, apply: (cal: FakeCalendar) => void): void {
		this.enter("PROPPATCH", this.listHref(listId));
		const cal = this.nc.userCalendars(this.ncUsername).get(listId);
		if (!cal) throw new CalDAVNotFound(`list '${listId}' not found`);
		apply(cal);
	}

	async renameList(listId: string, name: string): Promise<void> {
		this.proppatch(listId, (cal) => {
			cal.displayname = name;
		});
	}

	async setListOrder(listId: string, order: number): Promise<void> {
		this.proppatch(listId, (cal) => {
			cal.order = order;
		});
	}

	async setListSortMode(listId: string, sortMode: SortMode): Promise<void> {
		this.proppatch(listId, (cal) => {
			cal.sortMode = sortMode;
		});
	}

	async deleteList(listId: string): Promise<void> {
		this.enter("DELETE", this.listHref(listId));
		const cals = this.nc.userCalendars(this.ncUsername);
		if (!cals.delete(listId)) {
			throw new CalDAVNotFound(`list '${listId}' not found`);
		}
	}

	async getSyncToken(listHref: string): Promise<string> {
		this.enter("PROPFIND", listHref);
		const [calId, cal] = this.calendarAt(listHref);
		return FakeNextcloud.syncToken(this.ncUsername, calId, cal.version);
	}

	async fetchAllTasks(listHref: string): Promise<ObjectState[]> {
		this.enter("REPORT", listHref);
		const [calId, cal] = this.calendarAt(listHref);
		return [...cal.objects.entries()]
			.filter(([, obj]) => obj.ics.includes("BEGIN:VTODO"))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([filename, obj]) => this.state(calId, filename, obj));
	}

	async syncDelta(listHref: string, syncToken: string): Promise<DeltaResult> {
		this.enter("REPORT", listHref);
		const [calId, cal] = this.calendarAt(listHref);
		const prefix = `http://fake.local/ns/sync/${this.ncUsername}/${calId}/`;
		const since = syncToken.startsWith(prefix)
			? Number(syncToken.slice(prefix.length))
			: Number.NaN;
		if (!Number.isInteger(since) || since > cal.version) {
			throw new CalDAVSyncTokenInvalid(`sync-token rejected for '${listHref}'`);
		}
		const changed: ObjectState[] = [];
		const removedHrefs: string[] = [];
		const entries = [...cal.changes.entries()].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		for (const [filename, [version, deleted]] of entries) {
			if (version <= since) continue;
			const obj = cal.objects.get(filename);
			if (deleted || !obj) {
				removedHrefs.push(`${this.listHref(calId)}${filename}`);
			} else {
				changed.push(this.state(calId, filename, obj));
			}
		}
		return {
			changed,
			removedHrefs,
			syncToken: FakeNextcloud.syncToken(this.ncUsername, calId, cal.version),
		};
	}

	async getObject(href: string): Promise<ObjectState> {
		this.enter("GET", href);
		const [calId, cal, filename] = this.objectAt(href);
		const obj = cal.objects.get(filename);
		if (!obj) throw new CalDAVNotFound(`object '${href}' not found`);
		const state = this.state(calId, filename, obj);
		this.nc.runAfterGetHook(filename);
		return state;
	}

	/** `<uid>.ics` first, then a UID query (Apple-legacy filenames). */
	async findTask(listHref: string, uid: string): Promise<ObjectState | null> {
		const direct = `${listHref}${encodeURIComponent(uid)}.ics`;
		try {
			return await this.getObject(direct);
		} catch (err) {
			if (!(err instanceof CalDAVNotFound)) throw err;
		}
		this.enter("REPORT", listHref);
		const [calId, cal] = this.calendarAt(listHref);
		for (const [filename, obj] of cal.objects) {
			if (fakeUidOf(obj.ics) === uid) return this.state(calId, filename, obj);
		}
		return null;
	}

	async putObject(
		href: string,
		ics: string,
		options: PutOptions = {},
	): Promise<void> {
		this.enter("PUT", href);
		const [calId, cal, filename] = this.objectAt(href);
		const existing = cal.objects.get(filename);
		if (options.ifNoneMatch && existing) {
			throw new CalDAVPreconditionFailed(
				`PUT '${href}': object already exists`,
			);
		}
		if (options.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
			throw new CalDAVPreconditionFailed(`PUT '${href}': precondition failed`);
		}
		this.nc.putIcs(this.ncUsername, calId, filename, ics);
	}

	async deleteObject(href: string, options: DeleteOptions = {}): Promise<void> {
		this.enter("DELETE", href);
		const [calId, cal, filename] = this.objectAt(href);
		const existing = cal.objects.get(filename);
		if (!existing) throw new CalDAVNotFound(`object '${href}' not found`);
		if (options.ifMatch && existing.etag !== options.ifMatch) {
			throw new CalDAVPreconditionFailed(
				`DELETE '${href}': precondition failed`,
			);
		}
		this.nc.deleteIcs(this.ncUsername, calId, filename);
	}
}

/** CalDAVEngine.uidHintFromHref: object filename minus `.ics`, URL-decoded. */
export function fakeUidHintFromHref(href: string): string {
	const name = href.split("/").filter(Boolean).pop() ?? "";
	return decodeURIComponent(name.replace(/\.ics$/, ""));
}

// ---------------------------------------------------------------- fake mapper

/** One fake object: `NAME:value` lines between BEGIN:VTODO and END:VTODO. */
export function fakeVtodo(props: Record<string, string>): string {
	const lines = ["BEGIN:VCALENDAR", "BEGIN:VTODO"];
	for (const [name, value] of Object.entries(props)) {
		lines.push(`${name}:${value.replaceAll("\n", "\\n")}`);
	}
	lines.push("END:VTODO", "END:VCALENDAR");
	return `${lines.join("\r\n")}\r\n`;
}

function readProps(ics: string): Map<string, string> {
	if (!ics.includes("BEGIN:VTODO")) return new Map();
	const props = new Map<string, string>();
	for (const line of ics.split("\r\n")) {
		if (!line || line.startsWith("BEGIN:") || line.startsWith("END:")) continue;
		const colon = line.indexOf(":");
		if (colon < 0)
			throw new MapperError(`malformed line ${JSON.stringify(line)}`);
		props.set(
			line.slice(0, colon),
			line.slice(colon + 1).replaceAll("\\n", "\n"),
		);
	}
	return props;
}

function writeProps(props: Map<string, string>): string {
	return fakeVtodo(Object.fromEntries(props));
}

function fakeUidOf(ics: string): string | undefined {
	try {
		return readProps(ics).get("UID");
	} catch {
		return undefined;
	}
}

/** Python's `isoformat()` of an aware UTC datetime: `2026-07-02T08:30:00+00:00`. */
export function pyUtcIso(date: Date): string {
	return `${date.toISOString().slice(0, 19)}+00:00`;
}

function setFields(props: Map<string, string>, fields: OpTaskFields): void {
	for (const [key, value] of Object.entries(fields)) {
		switch (key) {
			case "title":
			case "notes":
				if (typeof value !== "string") {
					throw new MapperError(`invalid ${key} ${JSON.stringify(value)}`);
				}
				props.set(key === "title" ? "SUMMARY" : "DESCRIPTION", value);
				break;
			case "due":
				if (value === null) props.delete("DUE");
				else if (typeof value === "string") props.set("DUE", value);
				else throw new MapperError(`invalid due ${JSON.stringify(value)}`);
				break;
			case "due_has_time":
				if (typeof value !== "boolean") {
					throw new MapperError(
						`invalid due_has_time ${JSON.stringify(value)}`,
					);
				}
				props.set("X-DUE-HAS-TIME", value ? "TRUE" : "FALSE");
				break;
			case "priority":
				if (value !== 0 && value !== 1 && value !== 5 && value !== 9) {
					throw new MapperError(`invalid priority ${JSON.stringify(value)}`);
				}
				if (value === 0) props.delete("PRIORITY");
				else props.set("PRIORITY", String(value));
				break;
			case "sort_order":
				if (value === null) props.delete("X-APPLE-SORT-ORDER");
				else if (typeof value === "number" && Number.isInteger(value)) {
					props.set("X-APPLE-SORT-ORDER", String(value));
				} else {
					throw new MapperError(`invalid sort_order ${JSON.stringify(value)}`);
				}
				break;
		}
	}
}

/** Stand-in for ics.server's parse/build/apply functions (see the module doc). */
export const fakeMapper = {
	parseTask(ics: string): ParsedTask | null {
		const props = readProps(ics);
		if (props.size === 0) return null;
		const sortOrder = props.get("X-APPLE-SORT-ORDER");
		return {
			uid: props.get("UID") ?? "",
			title: props.get("SUMMARY") ?? "",
			notes: props.get("DESCRIPTION") ?? "",
			due: props.get("DUE") ?? null,
			due_has_time: props.get("X-DUE-HAS-TIME") === "TRUE",
			priority: Number(props.get("PRIORITY") ?? 0) as Priority,
			sort_order: sortOrder === undefined ? null : Number(sortOrder),
			completed: props.get("STATUS") === "COMPLETED",
			completed_at: props.get("COMPLETED") ?? null,
			recurring: props.has("RRULE"),
		};
	},

	buildVtodo(uid: string, fields: OpTaskFields, now: Date): string {
		const props = new Map<string, string>([
			["UID", uid],
			["DTSTAMP", pyUtcIso(now)],
			["STATUS", "NEEDS-ACTION"],
		]);
		setFields(props, fields);
		return writeProps(props);
	},

	applyFields(ics: string, fields: OpTaskFields, now: Date): string {
		const props = readProps(ics);
		setFields(props, fields);
		props.set("DTSTAMP", pyUtcIso(now));
		return writeProps(props);
	},

	/** RRULE:FREQ=DAILY with a UTC DUE rolls by whole days past the base; else completes. */
	applyComplete(ics: string, now: Date, completedAt?: Date | null): string {
		const props = readProps(ics);
		const base = completedAt ?? now;
		const due = props.get("DUE");
		if (props.get("RRULE") === "FREQ=DAILY" && due) {
			let next = new Date(due);
			while (next <= base) next = new Date(next.getTime() + 86_400_000);
			props.set("DUE", pyUtcIso(next));
		} else {
			props.set("STATUS", "COMPLETED");
			props.set("COMPLETED", pyUtcIso(base));
		}
		return writeProps(props);
	},

	applyUncomplete(ics: string, now: Date): string {
		const props = readProps(ics);
		props.set("STATUS", "NEEDS-ACTION");
		props.delete("COMPLETED");
		props.set("DTSTAMP", pyUtcIso(now));
		return writeProps(props);
	},
};

// ---------------------------------------------------------------- seed data

export const NC_USER = "viktor-nc";
export const NC_PASS = "correct-horse-battery";
export const APPLE_TIMED_UID = "6FD37E05-9AF0-4C0B-A9E9-D3B0E0F1A2B3";
export const APPLE_DAILY_UID = "11C0FFEE-AAAA-BBBB-CCCC-000000000001";
export const NC_SIMPLE_UID = "nc-web-3f2a1b4c5d6e";
export const NC_SIMPLE_TITLE = "Ring insurer about policy renewal";

export function ncSimple(uid = NC_SIMPLE_UID): string {
	return fakeVtodo({
		UID: uid,
		SUMMARY: NC_SIMPLE_TITLE,
		STATUS: "NEEDS-ACTION",
	});
}

/**
 * The Python conftest's `fake_nc`: one account, two task Lists, one
 * VEVENT-only calendar, three tasks in personal and one in work.
 */
export function seededNextcloud(): FakeNextcloud {
	const nc = new FakeNextcloud();
	nc.addUser(NC_USER, NC_PASS);
	nc.addCalendar(NC_USER, "personal", "Personal");
	nc.addCalendar(NC_USER, "work", "Work");
	nc.addCalendar(NC_USER, "contact_birthdays", "Birthdays", ["VEVENT"]);
	nc.putIcs(
		NC_USER,
		"personal",
		`${APPLE_TIMED_UID}.ics`,
		fakeVtodo({
			UID: APPLE_TIMED_UID,
			SUMMARY: "Water the plants",
			DUE: "2026-07-01T09:00:00+03:00",
			"X-DUE-HAS-TIME": "TRUE",
			PRIORITY: "1",
			"X-APPLE-SORT-ORDER": "740609486",
			RRULE: "FREQ=WEEKLY",
			STATUS: "NEEDS-ACTION",
		}),
	);
	nc.putIcs(
		NC_USER,
		"personal",
		"0D9E1F2A-3B4C-5D6E-7F80-91A2B3C4D5E6.ics",
		fakeVtodo({
			UID: "0D9E1F2A-3B4C-5D6E-7F80-91A2B3C4D5E6",
			SUMMARY: "Renew passport",
			DUE: "2026-06-15",
			STATUS: "COMPLETED",
			COMPLETED: "2026-06-15T19:15:00+00:00",
		}),
	);
	nc.putIcs(
		NC_USER,
		"personal",
		`${APPLE_DAILY_UID}.ics`,
		fakeVtodo({
			UID: APPLE_DAILY_UID,
			SUMMARY: "Vitamins",
			DUE: "2026-07-01T06:00:00+00:00",
			"X-DUE-HAS-TIME": "TRUE",
			RRULE: "FREQ=DAILY;COUNT=10",
			STATUS: "NEEDS-ACTION",
		}),
	);
	nc.putIcs(NC_USER, "work", `${NC_SIMPLE_UID}.ics`, ncSimple());
	return nc;
}
