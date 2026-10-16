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

/**
 * JSON.stringify plus Python's ensure_ascii: every UTF-16 code unit outside
 * printable ASCII (space to `~`) becomes a lowercase `\uXXXX` escape. Control
 * characters are already escaped by JSON.stringify the same way Python does
 * (`\n`, `\t`, ... and `\u00XX`); DEL and everything above it is not.
 */
function pythonJsonDumps(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const B64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUES = new Map([...B64_ALPHABET].map((ch, i) => [ch, i]));

/**
 * base64.urlsafe_b64decode, which is binascii.a2b_base64 in non-strict mode:
 * characters outside the alphabet are skipped, decoding stops once a quantum
 * is padded, and a dangling partial quantum is an error. Returns null where
 * Python raises binascii.Error.
 */
function urlsafeB64Decode(text: string): Uint8Array | null {
	const out: number[] = [];
	let quadPos = 0;
	let leftChar = 0;
	let pads = 0;
	for (const raw of text) {
		const ch = raw === "-" ? "+" : raw === "_" ? "/" : raw;
		if (ch === "=") {
			pads += 1;
			if (quadPos >= 2 && quadPos + pads >= 4) {
				return Uint8Array.from(out);
			}
			continue;
		}
		const value = B64_VALUES.get(ch);
		if (value === undefined) continue;
		pads = 0;
		switch (quadPos) {
			case 0:
				quadPos = 1;
				leftChar = value;
				break;
			case 1:
				quadPos = 2;
				out.push((leftChar << 2) | (value >> 4));
				leftChar = value & 0x0f;
				break;
			case 2:
				quadPos = 3;
				out.push((leftChar << 4) | (value >> 2));
				leftChar = value & 0x03;
				break;
			default:
				quadPos = 0;
				out.push((leftChar << 6) | value);
				leftChar = 0;
		}
	}
	return quadPos === 0 ? Uint8Array.from(out) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeCursor(tokens: SyncTokens, hrefUids?: HrefIndex): string {
	const payload = pythonJsonDumps({
		v: CURSOR_VERSION,
		tokens,
		hrefs: hrefUids ?? {},
	});
	return Buffer.from(payload, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function decodePayload(cursor: string): Record<string, unknown> | null {
	if (!cursor) return null;
	// Python encodes the str to UTF-8 before decoding; non-ASCII is skipped
	// as outside the alphabet either way.
	const bytes = urlsafeB64Decode(cursor);
	if (bytes === null) return null;
	let payload: unknown;
	try {
		const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		payload = JSON.parse(json);
	} catch {
		return null;
	}
	if (!isPlainObject(payload)) return null;
	// Python compares with `!=`, so `true` (== 1) passes as well.
	if (payload.v !== CURSOR_VERSION && payload.v !== true) return null;
	return payload;
}

/** Per-List sync-tokens, or null when empty or undecodable (full snapshot). */
export function decodeCursor(cursor: string): SyncTokens | null {
	const payload = decodePayload(cursor);
	if (payload === null) return null;
	const tokens = payload.tokens;
	if (!isPlainObject(tokens)) return null;
	const entries = Object.entries(tokens);
	if (!entries.every(([, v]) => typeof v === "string")) return null;
	return Object.fromEntries(entries) as SyncTokens;
}

/** The accumulated href-to-UID index; empty for an old or absent cursor. */
export function decodeHrefIndex(cursor: string): HrefIndex {
	const payload = decodePayload(cursor);
	if (payload === null) return {};
	const hrefs = payload.hrefs;
	if (!isPlainObject(hrefs)) return {};
	return Object.fromEntries(
		Object.entries(hrefs).filter(([, v]) => typeof v === "string"),
	) as HrefIndex;
}
