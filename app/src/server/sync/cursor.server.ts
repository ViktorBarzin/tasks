/**
 * The delta-sync cursor: an opaque base64 JSON blob of per-List sync-tokens.
 * Port of backend/tasks_api/cursor.py.
 *
 * Clients echo it back verbatim, and devices updating from the Python build
 * will send cursors it minted, so the encoding must be identical:
 * - payload is `{"v":1,"tokens":{...},"hrefs":{...}}`, compact separators,
 *   keys in that order, dict entries in insertion order;
 * - Python's json.dumps escapes non-ASCII as `\uXXXX` (ensure_ascii=True),
 *   which JSON.stringify does not: escape it the same way;
 * - base64.urlsafe_b64encode keeps `=` padding (Node's "base64url" drops it).
 *
 * Anything undecodable (bad base64, bad JSON, wrong `v`, non-string values)
 * means "no cursor", i.e. a full snapshot, so a corrupted cursor never wedges
 * a client. The `hrefs` index records only objects whose filename differs from
 * their UID (Apple-legacy names), so delete tombstones carry the real UID
 * (contract delta v1.1 §D).
 */
import { notImplemented } from "../not-implemented.server";

export const CURSOR_VERSION = 1;

/** List id to CalDAV sync-token. */
export type SyncTokens = Record<string, string>;
/** Object href to true UID. */
export type HrefIndex = Record<string, string>;

export function encodeCursor(tokens: SyncTokens, hrefUids?: HrefIndex): string {
	void tokens;
	void hrefUids;
	return notImplemented("encodeCursor");
}

/** Per-List sync-tokens, or null when empty or undecodable (full snapshot). */
export function decodeCursor(cursor: string): SyncTokens | null {
	void cursor;
	return notImplemented("decodeCursor");
}

/** The accumulated href-to-UID index; empty for an old or absent cursor. */
export function decodeHrefIndex(cursor: string): HrefIndex {
	void cursor;
	return notImplemented("decodeHrefIndex");
}
