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
import type { SyncResponse } from "#/shared/contract";
import type { CalDAVEngine } from "../caldav/engine.server";
import { notImplemented } from "../not-implemented.server";

export async function sync(
	engine: CalDAVEngine,
	cursor: string,
	accountKey: string,
): Promise<SyncResponse> {
	void engine;
	void cursor;
	return notImplemented(`sync(${accountKey})`);
}
