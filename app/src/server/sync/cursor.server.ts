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
export const CURSOR_VERSION = 1;

/** List id to CalDAV sync-token. */
export type SyncTokens = Record<string, string>;
/** Object href to true UID. */
export type HrefIndex = Record<string, string>;

/** Python's json.dumps(ensure_ascii=True) escapes everything outside printable ASCII. */
function asciiJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function encodeCursor(tokens: SyncTokens, hrefUids?: HrefIndex): string {
	const payload = asciiJson({
		v: CURSOR_VERSION,
		tokens,
		hrefs: hrefUids ?? {},
	});
	// urlsafe_b64encode keeps the `=` padding; Node's "base64url" would drop it.
	return Buffer.from(payload, "ascii")
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_");
}

/**
 * base64.urlsafe_b64decode: both alphabets, characters outside them ignored
 * (non-strict mode), and the padded length must work out.
 */
function decodeBase64(cursor: string): string | null {
	const cleaned = cursor
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.replace(/[^A-Za-z0-9+/=]/g, "");
	const body = cleaned.replace(/=+$/, "");
	if (body.includes("=") || cleaned.length % 4 !== 0 || body.length % 4 === 1) {
		return null;
	}
	const bytes = Buffer.from(body, "base64");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePayload(cursor: string): Record<string, unknown> | null {
	if (!cursor) return null;
	const text = decodeBase64(cursor);
	if (text === null) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(payload) || payload.v !== CURSOR_VERSION) return null;
	return payload;
}

/** Per-List sync-tokens, or null when empty or undecodable (full snapshot). */
export function decodeCursor(cursor: string): SyncTokens | null {
	const payload = decodePayload(cursor);
	if (payload === null) return null;
	const { tokens } = payload;
	if (!isRecord(tokens)) return null;
	if (!Object.values(tokens).every((v) => typeof v === "string")) return null;
	return tokens as SyncTokens;
}

/** The accumulated href-to-UID index; empty for an old or absent cursor. */
export function decodeHrefIndex(cursor: string): HrefIndex {
	const payload = decodePayload(cursor);
	if (payload === null || !isRecord(payload.hrefs)) return {};
	return Object.fromEntries(
		Object.entries(payload.hrefs).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}
