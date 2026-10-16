/**
 * Per-user CalDAV client for Nextcloud: the only module that speaks DAV.
 * Port of backend/tasks_api/caldav_engine.py, one method per Python method.
 *
 * Built on a fetch-shaped transport so tests swap Nextcloud for an in-memory
 * fake (the port of backend/tests/fake_caldav.py) with zero network, the way
 * the Python tests used httpx.MockTransport.
 *
 * It implements exactly the slice of RFC 4791/6578 this app needs:
 * - PROPFIND current-user-principal (onboarding's live credential check)
 * - PROPFIND Depth:1 on the calendar home: VTODO-capable Lists
 * - REPORT sync-collection per List (delta sync); a rejected token raises
 *   CalDAVSyncTokenInvalid
 * - REPORT calendar-multiget / calendar-query, GET/PUT/DELETE with ETags
 *   (If-Match / If-None-Match), MKCALENDAR, PROPPATCH
 *
 * Behaviour to carry over exactly (see the Python source and its tests):
 * - 401 from Nextcloud: CalDAVUnauthorized. 5xx, timeout or transport error:
 *   CalDAVTransient (the op is reported `retry`).
 * - The openresty edge quirks in put_object/delete_object: a 304 answer to
 *   `If-None-Match: *` and a blanket 412 to `If-Match` are re-checked with a
 *   GET of the current ETag before deciding (infra#65).
 * - Hrefs the server returns are used verbatim; engine-relative paths such as
 *   `/calendars/<user>/<list>/` resolve under the configured base URL.
 * - list_task_lists sorts by id; unparseable calendar-order is null; a
 *   sort-mode outside the three values is null.
 *
 * Divergence from Python, on purpose: ICS bodies are strings (UTF-8), not bytes.
 * calendar-data read from a REPORT goes through XML parsing, which turns CRLF
 * into LF, exactly as it did under ElementTree.
 */
import { SORT_MODES, type SortMode } from "#/shared/contract";
import {
	escapeXml,
	find,
	findAll,
	parseXml,
	type Step,
	textOf,
	type XmlElement,
} from "./xml.server";

export const DAV_NS = "DAV:";
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
/** Apple's calendar-extension namespace: holds `calendar-order`. */
export const APPLE_NS = "http://apple.com/ns/ical/";
/** This app's namespace for dead properties: the shared `sort-mode` (contract v1.4). */
export const TASKS_NS = "urn:viktorbarzin:tasks";

/** Default per-request timeout, as httpx.Timeout(30.0). */
export const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- errors

export class CalDAVError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** Nextcloud rejected the app password (revoked or rotated: re-onboard). */
export class CalDAVUnauthorized extends CalDAVError {}

/** Nextcloud 5xx or a network timeout: not applied, safe to resend (`retry`). */
export class CalDAVTransient extends CalDAVError {}

/** The object or collection does not exist. */
export class CalDAVNotFound extends CalDAVError {}

/** An ETag precondition (If-Match / If-None-Match) failed: a stale write. */
export class CalDAVPreconditionFailed extends CalDAVError {}

/** MKCALENDAR target already exists. */
export class CalDAVAlreadyExists extends CalDAVError {}

/** The server no longer honours this sync-token: resync from scratch. */
export class CalDAVSyncTokenInvalid extends CalDAVError {}

// ---------------------------------------------------------------- values

/** A VTODO-capable calendar collection (a List). */
export interface ListInfo {
	id: string;
	href: string;
	name: string;
	/** Apple `calendar-order`; null when unset or unparseable. */
	order: number | null;
	/** `sort-mode` dead property; null when unset or unrecognised. */
	sortMode: SortMode | null;
}

/** One CalDAV object as fetched: server href, ETag and raw ICS. */
export interface ObjectState {
	href: string;
	etag: string;
	ics: string;
}

/** Outcome of one per-List sync round. */
export interface DeltaResult {
	changed: ObjectState[];
	removedHrefs: string[];
	syncToken: string;
}

/**
 * How the engine reaches Nextcloud. Production uses `fetch`; tests pass the
 * fake server's handler. The engine adds Basic auth and the timeout signal
 * itself.
 */
export type CalDAVTransport = (request: Request) => Promise<Response>;

export interface CalDAVEngineOptions {
	baseUrl: string;
	ncUsername: string;
	appPassword: string;
	transport?: CalDAVTransport;
	timeoutMs?: number;
}

export interface PutOptions {
	ifMatch?: string | null;
	ifNoneMatch?: boolean;
}

export interface DeleteOptions {
	ifMatch?: string | null;
}

// ---------------------------------------------------------------- helpers

const d = (name: string, deep = false): Step => ({ ns: DAV_NS, name, deep });
const c = (name: string, deep = false): Step => ({ ns: CALDAV_NS, name, deep });
const a = (name: string, deep = false): Step => ({ ns: APPLE_NS, name, deep });
const vb = (name: string, deep = false): Step => ({ ns: TASKS_NS, name, deep });

/** `.//d:propstat/d:prop/<step>`: the first such property in document order. */
const propPath = (step: Step): Step[] => [d("propstat", true), d("prop"), step];

const XML_HEADERS = { "Content-Type": "application/xml; charset=utf-8" };
const ICS_HEADERS = { "Content-Type": "text/calendar; charset=utf-8" };
const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';

/** urllib.parse.quote(value, safe=""): everything but A-Z a-z 0-9 _ . - ~. */
export function pyQuote(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * urllib.parse.unquote: %XX runs decode as UTF-8, invalid sequences become
 * U+FFFD, and a stray `%` is kept as-is.
 */
export function pyUnquote(value: string): string {
	return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
		const bytes = Uint8Array.from(run.match(/%[0-9A-Fa-f]{2}/g) ?? [], (h) =>
			Number.parseInt(h.slice(1), 16),
		);
		return new TextDecoder("utf-8").decode(bytes);
	});
}

/** The last path segment of an href, trailing slashes ignored, decoded. */
function lastSegment(href: string): string {
	return pyUnquote(href.replace(/\/+$/, "").split("/").at(-1) ?? "");
}

/** Python's sorted() order for str keys: by code point, not UTF-16 unit. */
function byCodePoint(x: string, y: string): number {
	const xs = [...x];
	const ys = [...y];
	for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
		const diff = (xs[i]?.codePointAt(0) ?? 0) - (ys[i]?.codePointAt(0) ?? 0);
		if (diff !== 0) return diff;
	}
	return xs.length - ys.length;
}

/** A `calendar-order` value; null when absent, empty or not an integer. */
function parseOrder(raw: string): number | null {
	const text = raw.trim();
	if (!/^[+-]?\d+(_\d+)*$/.test(text)) return null;
	const value = Number(text.replace(/_/g, ""));
	return Number.isSafeInteger(value) ? value : null;
}

/** A `sort-mode` value; null unless it is one of the three modes (v1.4 §1). */
function parseSortMode(raw: string): SortMode | null {
	const value = raw.trim();
	return SORT_MODES.find((mode) => mode === value) ?? null;
}

interface DavResponse {
	status: number;
	headers: Headers;
	body: string;
}

function describeError(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
	if (err instanceof DOMException) {
		return err.name === "TimeoutError" || err.name === "AbortError";
	}
	return signal.aborted;
}

// ---------------------------------------------------------------- engine

export class CalDAVEngine {
	readonly ncUsername: string;
	private readonly origin: string;
	private readonly basePath: string;
	private readonly authorization: string;
	private readonly transport: CalDAVTransport;
	private readonly timeoutMs: number;

	constructor(options: CalDAVEngineOptions) {
		const url = new URL(options.baseUrl.replace(/\/+$/, ""));
		this.origin = `${url.protocol}//${url.host}`;
		this.basePath = url.pathname === "/" ? "" : url.pathname;
		this.ncUsername = options.ncUsername;
		this.authorization = `Basic ${Buffer.from(
			`${options.ncUsername}:${options.appPassword}`,
			"utf8",
		).toString("base64")}`;
		this.transport = options.transport ?? ((request) => fetch(request));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Releases resources. A no-op with fetch; kept for parity with `async with`. */
	async close(): Promise<void> {}

	// -- plumbing

	/**
	 * Server hrefs (already under the DAV base path) and engine-relative paths
	 * both resolve to absolute URLs.
	 */
	private url(path: string): string {
		if (path.startsWith(`${this.basePath}/`)) return this.origin + path;
		return this.origin + this.basePath + path;
	}

	/** The user's calendar home: `/calendars/<user>/` (Nextcloud convention). */
	homePath(): string {
		return `/calendars/${pyQuote(this.ncUsername)}/`;
	}

	listPath(listId: string): string {
		return `${this.homePath()}${pyQuote(listId)}/`;
	}

	objectPath(listId: string, uid: string): string {
		return `${this.listPath(listId)}${pyQuote(uid)}.ics`;
	}

	/** Last path segment of a collection href, URL-decoded: the List id. */
	static listIdFromHref(href: string): string {
		return lastSegment(href);
	}

	/**
	 * Object filename minus `.ics`, URL-decoded: equals the UID for objects
	 * this app (and, in practice, Apple and Nextcloud) creates; used for
	 * delete tombstones, where the body is gone.
	 */
	static uidHintFromHref(href: string): string {
		const name = lastSegment(href);
		return name.endsWith(".ics") ? name.slice(0, -4) : name;
	}

	private async request(
		method: string,
		path: string,
		headers: Record<string, string> = {},
		body?: string,
	): Promise<DavResponse> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		const request = new Request(this.url(path), {
			method,
			headers: { ...headers, Authorization: this.authorization },
			body,
			signal,
		});
		let response: Response;
		let text: string;
		try {
			response = await this.transport(request);
			text = await response.text();
		} catch (err) {
			if (isTimeout(err, signal)) {
				throw new CalDAVTransient(`${method} ${path}: upstream timed out`);
			}
			throw new CalDAVTransient(
				`${method} ${path}: upstream transport error: ${describeError(err)}`,
			);
		}
		if (response.status === 401) {
			throw new CalDAVUnauthorized(
				`${method} ${path}: Nextcloud rejected the credentials`,
			);
		}
		if (response.status >= 500) {
			// Transient upstream (Nextcloud/sabre) failure: resendable (B).
			throw new CalDAVTransient(
				`${method} ${path}: upstream HTTP ${response.status}`,
			);
		}
		return { status: response.status, headers: response.headers, body: text };
	}

	private static multistatus(response: DavResponse): XmlElement {
		try {
			return parseXml(response.body);
		} catch (err) {
			throw new CalDAVError(
				`unparseable multistatus response: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// -- onboarding

	/** Live PROPFIND for the current-user principal. False on 401. */
	async validateCredentials(): Promise<boolean> {
		const body = `${XML_DECL}<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
		let response: DavResponse;
		try {
			response = await this.request(
				"PROPFIND",
				"/",
				{ Depth: "0", ...XML_HEADERS },
				body,
			);
		} catch (err) {
			if (err instanceof CalDAVUnauthorized) return false;
			throw err;
		}
		if (response.status !== 207) {
			throw new CalDAVError(
				`principal PROPFIND failed: HTTP ${response.status}`,
			);
		}
		const root = CalDAVEngine.multistatus(response);
		const principal = find(root, [
			d("current-user-principal", true),
			d("href"),
		]);
		return principal !== null && principal.text.trim() !== "";
	}

	// -- lists

	/** VTODO-capable collections under the calendar home, sorted by id. */
	async listTaskLists(): Promise<ListInfo[]> {
		const body =
			`${XML_DECL}<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV_NS}"` +
			` xmlns:a="${APPLE_NS}" xmlns:vb="${TASKS_NS}">` +
			"<d:prop><d:resourcetype/><d:displayname/><a:calendar-order/><vb:sort-mode/>" +
			"<c:supported-calendar-component-set/></d:prop></d:propfind>";
		const response = await this.request(
			"PROPFIND",
			this.homePath(),
			{ Depth: "1", ...XML_HEADERS },
			body,
		);
		if (response.status !== 207) {
			throw new CalDAVError(
				`calendar-home PROPFIND failed: HTTP ${response.status}`,
			);
		}
		const lists: ListInfo[] = [];
		for (const resp of findAll(CalDAVEngine.multistatus(response), [
			d("response"),
		])) {
			const href = textOf(find(resp, [d("href")])).trim();
			if (!href) continue;
			const resourcetype = find(resp, propPath(d("resourcetype")));
			if (
				resourcetype === null ||
				find(resourcetype, [c("calendar")]) === null
			) {
				continue;
			}
			const components = findAll(resp, [
				...propPath(c("supported-calendar-component-set")),
				c("comp"),
			]);
			const supported = new Set(
				components.map((comp) => (comp.attributes.name ?? "").toUpperCase()),
			);
			if (supported.size > 0 && !supported.has("VTODO")) continue;
			const id = CalDAVEngine.listIdFromHref(href);
			const name = textOf(find(resp, propPath(d("displayname")))).trim();
			lists.push({
				id,
				href,
				name: name || id,
				order: parseOrder(textOf(find(resp, propPath(a("calendar-order"))))),
				sortMode: parseSortMode(textOf(find(resp, propPath(vb("sort-mode"))))),
			});
		}
		return lists.sort((x, y) => byCodePoint(x.id, y.id));
	}

	/** MKCALENDAR a VTODO collection. Conflict: CalDAVAlreadyExists. */
	async createList(listId: string, name: string): Promise<void> {
		const body =
			`${XML_DECL}<c:mkcalendar xmlns:d="DAV:" xmlns:c="${CALDAV_NS}">` +
			"<d:set><d:prop>" +
			`<d:displayname>${escapeXml(name)}</d:displayname>` +
			'<c:supported-calendar-component-set><c:comp name="VTODO"/>' +
			"</c:supported-calendar-component-set>" +
			"</d:prop></d:set></c:mkcalendar>";
		const response = await this.request(
			"MKCALENDAR",
			this.listPath(listId),
			XML_HEADERS,
			body,
		);
		if (response.status === 405) {
			throw new CalDAVAlreadyExists(`list '${listId}' already exists`);
		}
		if (response.status !== 201 && response.status !== 204) {
			throw new CalDAVError(
				`MKCALENDAR '${listId}' failed: HTTP ${response.status}`,
			);
		}
	}

	/** PROPPATCH one collection property; shared by rename, reorder and sort mode. */
	private async proppatchList(listId: string, propXml: string): Promise<void> {
		const body =
			`${XML_DECL}<d:propertyupdate xmlns:d="DAV:" xmlns:a="${APPLE_NS}" xmlns:vb="${TASKS_NS}">` +
			`<d:set><d:prop>${propXml}</d:prop></d:set></d:propertyupdate>`;
		const response = await this.request(
			"PROPPATCH",
			this.listPath(listId),
			XML_HEADERS,
			body,
		);
		if (response.status === 404) {
			throw new CalDAVNotFound(`list '${listId}' not found`);
		}
		if (response.status !== 200 && response.status !== 207) {
			throw new CalDAVError(
				`PROPPATCH '${listId}' failed: HTTP ${response.status}`,
			);
		}
		const status = textOf(
			find(CalDAVEngine.multistatus(response), [
				d("propstat", true),
				d("status"),
			]),
		);
		if (!status.includes("200")) {
			throw new CalDAVError(
				`PROPPATCH '${listId}' rejected: ${status || "no status"}`,
			);
		}
	}

	/** PROPPATCH the displayname. */
	async renameList(listId: string, name: string): Promise<void> {
		await this.proppatchList(
			listId,
			`<d:displayname>${escapeXml(name)}</d:displayname>`,
		);
	}

	/** PROPPATCH Apple `calendar-order` (contract v1.2). */
	async setListOrder(listId: string, order: number): Promise<void> {
		if (!Number.isSafeInteger(order)) {
			throw new RangeError(`invalid calendar-order ${order}`);
		}
		await this.proppatchList(
			listId,
			`<a:calendar-order>${order}</a:calendar-order>`,
		);
	}

	/**
	 * PROPPATCH the `sort-mode` dead property (contract v1.4). Callers (ops)
	 * validate the value; this guard means the engine can never write a value
	 * it would refuse to read back.
	 */
	async setListSortMode(listId: string, sortMode: SortMode): Promise<void> {
		if (!SORT_MODES.includes(sortMode)) {
			throw new RangeError(`invalid sort_mode '${String(sortMode)}'`);
		}
		await this.proppatchList(
			listId,
			`<vb:sort-mode>${escapeXml(sortMode)}</vb:sort-mode>`,
		);
	}

	/** DELETE the collection (Nextcloud keeps it in the trashbin). 404: CalDAVNotFound. */
	async deleteList(listId: string): Promise<void> {
		const response = await this.request("DELETE", this.listPath(listId));
		if (response.status === 404) {
			throw new CalDAVNotFound(`list '${listId}' not found`);
		}
		if (response.status !== 200 && response.status !== 204) {
			throw new CalDAVError(
				`DELETE list '${listId}' failed: HTTP ${response.status}`,
			);
		}
	}

	// -- sync

	async getSyncToken(listHref: string): Promise<string> {
		const body = `${XML_DECL}<d:propfind xmlns:d="DAV:"><d:prop><d:sync-token/></d:prop></d:propfind>`;
		const response = await this.request(
			"PROPFIND",
			listHref,
			{ Depth: "0", ...XML_HEADERS },
			body,
		);
		if (response.status === 404) {
			throw new CalDAVNotFound(`list '${listHref}' not found`);
		}
		if (response.status !== 207) {
			throw new CalDAVError(
				`sync-token PROPFIND failed: HTTP ${response.status}`,
			);
		}
		const token = textOf(
			find(CalDAVEngine.multistatus(response), propPath(d("sync-token"))),
		);
		if (!token) {
			throw new CalDAVError(`list '${listHref}' exposes no sync-token`);
		}
		return token.trim();
	}

	/** Full calendar-query REPORT for every VTODO in the List. */
	async fetchAllTasks(listHref: string): Promise<ObjectState[]> {
		const body =
			`${XML_DECL}<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV_NS}">` +
			"<d:prop><d:getetag/><c:calendar-data/></d:prop>" +
			'<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/>' +
			"</c:comp-filter></c:filter></c:calendar-query>";
		const response = await this.request(
			"REPORT",
			listHref,
			{ Depth: "1", ...XML_HEADERS },
			body,
		);
		if (response.status === 404) {
			throw new CalDAVNotFound(`list '${listHref}' not found`);
		}
		if (response.status !== 207) {
			throw new CalDAVError(
				`calendar-query REPORT failed: HTTP ${response.status}`,
			);
		}
		return CalDAVEngine.objectStates(CalDAVEngine.multistatus(response));
	}

	/**
	 * RFC 6578 sync-collection REPORT plus a multiget of the changed objects.
	 * A token the server no longer accepts raises CalDAVSyncTokenInvalid
	 * (callers restart with a full snapshot).
	 */
	async syncDelta(listHref: string, syncToken: string): Promise<DeltaResult> {
		const body =
			`${XML_DECL}<d:sync-collection xmlns:d="DAV:">` +
			`<d:sync-token>${escapeXml(syncToken)}</d:sync-token>` +
			"<d:sync-level>1</d:sync-level>" +
			"<d:prop><d:getetag/></d:prop></d:sync-collection>";
		const response = await this.request("REPORT", listHref, XML_HEADERS, body);
		if (response.status === 404) {
			throw new CalDAVNotFound(`list '${listHref}' not found`);
		}
		if ([400, 403, 409].includes(response.status)) {
			// sabre/Nextcloud reports an expired or foreign token as 403 with a
			// DAV:valid-sync-token precondition; treat the family as invalid.
			throw new CalDAVSyncTokenInvalid(
				`sync-token rejected for '${listHref}': HTTP ${response.status}`,
			);
		}
		if (response.status !== 207) {
			throw new CalDAVError(
				`sync-collection REPORT failed: HTTP ${response.status}`,
			);
		}
		const root = CalDAVEngine.multistatus(response);
		const changedHrefs: string[] = [];
		const removedHrefs: string[] = [];
		const self = listHref.replace(/\/+$/, "");
		for (const resp of findAll(root, [d("response")])) {
			const href = textOf(find(resp, [d("href")])).trim();
			if (!href || href.replace(/\/+$/, "") === self) continue;
			const status = textOf(find(resp, [d("status")]));
			if (status.includes("404")) removedHrefs.push(href);
			else changedHrefs.push(href);
		}
		const newToken = textOf(find(root, [d("sync-token")])).trim();
		if (!newToken) {
			throw new CalDAVError(
				`sync-collection response for '${listHref}' lacks a sync-token`,
			);
		}
		const changed =
			changedHrefs.length > 0
				? await this.multiget(listHref, changedHrefs)
				: [];
		return { changed, removedHrefs, syncToken: newToken };
	}

	async multiget(listHref: string, hrefs: string[]): Promise<ObjectState[]> {
		const hrefXml = hrefs
			.map((h) => `<d:href>${escapeXml(h)}</d:href>`)
			.join("");
		const body =
			`${XML_DECL}<c:calendar-multiget xmlns:d="DAV:" xmlns:c="${CALDAV_NS}">` +
			`<d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefXml}` +
			"</c:calendar-multiget>";
		const response = await this.request(
			"REPORT",
			listHref,
			{ Depth: "1", ...XML_HEADERS },
			body,
		);
		if (response.status !== 207) {
			throw new CalDAVError(
				`calendar-multiget REPORT failed: HTTP ${response.status}`,
			);
		}
		return CalDAVEngine.objectStates(CalDAVEngine.multistatus(response));
	}

	private static objectStates(root: XmlElement): ObjectState[] {
		const states: ObjectState[] = [];
		for (const resp of findAll(root, [d("response")])) {
			const href = textOf(find(resp, [d("href")])).trim();
			const data = find(resp, propPath(c("calendar-data")));
			const etag = textOf(find(resp, propPath(d("getetag")))).trim();
			if (!href || data === null || !data.text.trim()) continue;
			states.push({ href, etag, ics: data.text });
		}
		return states;
	}

	// -- objects

	async getObject(href: string): Promise<ObjectState> {
		const response = await this.request("GET", href);
		if (response.status === 404) {
			throw new CalDAVNotFound(`object '${href}' not found`);
		}
		if (response.status !== 200) {
			throw new CalDAVError(`GET '${href}' failed: HTTP ${response.status}`);
		}
		return {
			href,
			etag: response.headers.get("ETag") ?? "",
			ics: response.body,
		};
	}

	/**
	 * Locate a VTODO by UID: the `<uid>.ics` convention first, then a
	 * UID-filtered calendar-query (objects created by other clients, such as
	 * Apple-legacy filenames, may use any name).
	 */
	async findTask(listHref: string, uid: string): Promise<ObjectState | null> {
		const direct = `${listHref.replace(/\/+$/, "")}/${pyQuote(uid)}.ics`;
		try {
			return await this.getObject(direct);
		} catch (err) {
			if (!(err instanceof CalDAVNotFound)) throw err;
		}
		const body =
			`${XML_DECL}<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV_NS}">` +
			"<d:prop><d:getetag/><c:calendar-data/></d:prop>" +
			'<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO">' +
			'<c:prop-filter name="UID"><c:text-match collation="i;octet">' +
			`${escapeXml(uid)}</c:text-match></c:prop-filter>` +
			"</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>";
		const response = await this.request(
			"REPORT",
			listHref,
			{ Depth: "1", ...XML_HEADERS },
			body,
		);
		if (response.status === 404) {
			throw new CalDAVNotFound(`list '${listHref}' not found`);
		}
		if (response.status !== 207) {
			throw new CalDAVError(
				`UID calendar-query failed: HTTP ${response.status}`,
			);
		}
		return (
			CalDAVEngine.objectStates(CalDAVEngine.multistatus(response))[0] ?? null
		);
	}

	/**
	 * The object's ETag right now, or null when it does not exist. The probe
	 * for the broken-edge fallbacks: a plain GET carries no conditional
	 * headers, so it always reaches the origin.
	 */
	private async currentEtag(href: string): Promise<string | null> {
		const response = await this.request("GET", href);
		if (response.status === 404) return null;
		if (response.status !== 200) {
			throw new CalDAVError(`GET '${href}' failed: HTTP ${response.status}`);
		}
		return response.headers.get("ETag") ?? "";
	}

	async putObject(
		href: string,
		ics: string,
		options: PutOptions = {},
	): Promise<void> {
		const { ifMatch, ifNoneMatch = false } = options;
		const headers: Record<string, string> = { ...ICS_HEADERS };
		if (ifMatch) headers["If-Match"] = ifMatch;
		if (ifNoneMatch) headers["If-None-Match"] = "*";
		let response = await this.request("PUT", href, headers, ics);
		if (response.status === 304 && ifNoneMatch) {
			// RFC 9110 §15.4.5 reserves 304 for GET/HEAD: a compliant origin can
			// never answer a PUT with it. Our ingress (openresty) does: it
			// terminates `If-None-Match: *` writes at the edge. Degrade: re-check
			// existence with a plain GET, then retry unguarded (the op journal
			// still absorbs replays).
			if ((await this.currentEtag(href)) !== null) {
				throw new CalDAVPreconditionFailed(
					`PUT '${href}': object already exists`,
				);
			}
			response = await this.request("PUT", href, { ...ICS_HEADERS }, ics);
		} else if (response.status === 412 && ifMatch) {
			// The same edge answers every `If-Match` PUT with a blanket 412. A
			// 412 is also a legitimate origin answer, so verify: retry
			// unguarded only when the precondition provably still holds; a
			// differing tag is a genuine conflict and stays a 412 for the
			// silent-LWW loop in ops.
			const current = await this.currentEtag(href);
			if (current === null) {
				throw new CalDAVNotFound(`object '${href}' not found`);
			}
			if (current !== ifMatch) {
				throw new CalDAVPreconditionFailed(
					`PUT '${href}': precondition failed`,
				);
			}
			response = await this.request("PUT", href, { ...ICS_HEADERS }, ics);
		}
		if (response.status === 412) {
			throw new CalDAVPreconditionFailed(`PUT '${href}': precondition failed`);
		}
		if (response.status === 404) {
			throw new CalDAVNotFound(`PUT '${href}': parent collection not found`);
		}
		if (![200, 201, 204].includes(response.status)) {
			throw new CalDAVError(`PUT '${href}' failed: HTTP ${response.status}`);
		}
	}

	async deleteObject(href: string, options: DeleteOptions = {}): Promise<void> {
		const { ifMatch } = options;
		const headers: Record<string, string> = {};
		if (ifMatch) headers["If-Match"] = ifMatch;
		let response = await this.request("DELETE", href, headers);
		if (response.status === 412 && ifMatch) {
			// Broken-edge fallback, same reasoning as in putObject.
			const current = await this.currentEtag(href);
			if (current === null) {
				throw new CalDAVNotFound(`object '${href}' not found`);
			}
			if (current !== ifMatch) {
				throw new CalDAVPreconditionFailed(
					`DELETE '${href}': precondition failed`,
				);
			}
			response = await this.request("DELETE", href);
		}
		if (response.status === 412) {
			throw new CalDAVPreconditionFailed(
				`DELETE '${href}': precondition failed`,
			);
		}
		if (response.status === 404) {
			throw new CalDAVNotFound(`object '${href}' not found`);
		}
		if (response.status !== 200 && response.status !== 204) {
			throw new CalDAVError(`DELETE '${href}' failed: HTTP ${response.status}`);
		}
	}
}
