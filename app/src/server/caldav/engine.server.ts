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
 */
import type { SortMode } from "#/shared/contract";
import { notImplemented } from "../not-implemented.server";

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

// ---------------------------------------------------------------- engine

export class CalDAVEngine {
	readonly ncUsername: string;

	constructor(options: CalDAVEngineOptions) {
		this.ncUsername = options.ncUsername;
	}

	/** Releases resources. A no-op with fetch; kept for parity with `async with`. */
	async close(): Promise<void> {}

	// -- paths

	/** The user's calendar home: `/calendars/<user>/` (Nextcloud convention). */
	homePath(): string {
		return notImplemented("CalDAVEngine.homePath");
	}

	listPath(listId: string): string {
		return notImplemented(`CalDAVEngine.listPath(${listId})`);
	}

	objectPath(listId: string, uid: string): string {
		return notImplemented(`CalDAVEngine.objectPath(${listId}, ${uid})`);
	}

	/** Last path segment of a collection href, URL-decoded: the List id. */
	static listIdFromHref(href: string): string {
		return notImplemented(`CalDAVEngine.listIdFromHref(${href})`);
	}

	/** Object filename minus `.ics`, URL-decoded: the UID hint for tombstones. */
	static uidHintFromHref(href: string): string {
		return notImplemented(`CalDAVEngine.uidHintFromHref(${href})`);
	}

	// -- onboarding

	/** Live PROPFIND for the current-user principal. False on 401. */
	async validateCredentials(): Promise<boolean> {
		return notImplemented("CalDAVEngine.validateCredentials");
	}

	// -- lists

	/** VTODO-capable collections under the calendar home, sorted by id. */
	async listTaskLists(): Promise<ListInfo[]> {
		return notImplemented("CalDAVEngine.listTaskLists");
	}

	/** MKCALENDAR a VTODO collection. Conflict: CalDAVAlreadyExists. */
	async createList(listId: string, name: string): Promise<void> {
		return notImplemented(`CalDAVEngine.createList(${listId}, ${name})`);
	}

	/** PROPPATCH the displayname. */
	async renameList(listId: string, name: string): Promise<void> {
		return notImplemented(`CalDAVEngine.renameList(${listId}, ${name})`);
	}

	/** PROPPATCH Apple `calendar-order` (contract v1.2). */
	async setListOrder(listId: string, order: number): Promise<void> {
		return notImplemented(`CalDAVEngine.setListOrder(${listId}, ${order})`);
	}

	/** PROPPATCH the `sort-mode` dead property (contract v1.4). */
	async setListSortMode(listId: string, sortMode: SortMode): Promise<void> {
		return notImplemented(
			`CalDAVEngine.setListSortMode(${listId}, ${sortMode})`,
		);
	}

	/** DELETE the collection (Nextcloud keeps it in the trashbin). 404: CalDAVNotFound. */
	async deleteList(listId: string): Promise<void> {
		return notImplemented(`CalDAVEngine.deleteList(${listId})`);
	}

	// -- sync

	async getSyncToken(listHref: string): Promise<string> {
		return notImplemented(`CalDAVEngine.getSyncToken(${listHref})`);
	}

	/** Full calendar-query REPORT for every VTODO in the List. */
	async fetchAllTasks(listHref: string): Promise<ObjectState[]> {
		return notImplemented(`CalDAVEngine.fetchAllTasks(${listHref})`);
	}

	/** RFC 6578 sync-collection REPORT plus a multiget of the changed objects. */
	async syncDelta(listHref: string, syncToken: string): Promise<DeltaResult> {
		return notImplemented(`CalDAVEngine.syncDelta(${listHref}, ${syncToken})`);
	}

	async multiget(listHref: string, hrefs: string[]): Promise<ObjectState[]> {
		return notImplemented(
			`CalDAVEngine.multiget(${listHref}, ${hrefs.length})`,
		);
	}

	// -- objects

	async getObject(href: string): Promise<ObjectState> {
		return notImplemented(`CalDAVEngine.getObject(${href})`);
	}

	/** `<uid>.ics` first, then a UID calendar-query (Apple-legacy filenames). */
	async findTask(listHref: string, uid: string): Promise<ObjectState | null> {
		return notImplemented(`CalDAVEngine.findTask(${listHref}, ${uid})`);
	}

	async putObject(
		href: string,
		ics: string,
		options?: PutOptions,
	): Promise<void> {
		void ics;
		void options;
		return notImplemented(`CalDAVEngine.putObject(${href})`);
	}

	async deleteObject(href: string, options?: DeleteOptions): Promise<void> {
		void options;
		return notImplemented(`CalDAVEngine.deleteObject(${href})`);
	}
}
