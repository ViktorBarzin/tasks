/**
 * Port of backend/tests/test_cursor.py, plus byte-compatibility with cursors
 * the Python build minted (devices updating across the cutover send them).
 *
 * The delta-sync cursor is an opaque, corruption-proof blob: anything the
 * server did not mint decodes to null (a full snapshot), never an error.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { decodeCursor, decodeHrefIndex, encodeCursor } from "./cursor.server";

const b64url = (text: string) =>
	Buffer.from(text, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");

describe("cursor (test_cursor.py)", () => {
	test("round trip", () => {
		const tokens = {
			personal: "http://sabre.io/ns/sync/42",
			work: "http://sabre.io/ns/sync/7",
		};
		expect(decodeCursor(encodeCursor(tokens))).toEqual(tokens);
	});

	test("empty tokens round trip", () => {
		expect(decodeCursor(encodeCursor({}))).toEqual({});
	});

	test("cursor is url-safe ASCII", () => {
		const cursor = encodeCursor({ "lišta/á": "token with spaces & ?=" });
		expect(cursor).toBe(cursor.trim());
		expect(cursor).toMatch(/^[A-Za-z0-9_=-]+$/);
		expect(cursor.length % 4).toBe(0); // padded, like urlsafe_b64encode
	});

	test("empty cursor means full snapshot", () => {
		expect(decodeCursor("")).toBeNull();
	});

	test("garbage is null, not an error", () => {
		expect(decodeCursor("not-base64 at all!!")).toBeNull();
		expect(decodeCursor(b64url("not json"))).toBeNull();
		expect(decodeCursor(b64url('"a json string"'))).toBeNull();
	});

	test("wrong version is null", () => {
		expect(decodeCursor(b64url('{"v": 0, "tokens": {}}'))).toBeNull();
	});

	test("non-string tokens are null", () => {
		expect(
			decodeCursor(b64url('{"v": 1, "tokens": {"personal": 42}}')),
		).toBeNull();
		expect(decodeCursor(b64url('{"v": 1}'))).toBeNull();
	});

	test("property: any token map round trips", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.string({ minLength: 1, unit: "binary" }),
					fc.string({ unit: "binary" }),
				),
				(tokens) => {
					expect(decodeCursor(encodeCursor(tokens))).toEqual(tokens);
				},
			),
		);
	});

	test("property: decode never throws", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), (junk) => {
				const result = decodeCursor(junk);
				expect(result === null || typeof result === "object").toBe(true);
			}),
		);
	});
});

describe("cursor byte-compatibility with the Python build", () => {
	// Minted by backend/tasks_api/cursor.py:
	//   encode_cursor({"personal": "http://sabre.io/ns/sync/42", "lišta": "t ü"},
	//                 {"/remote.php/dav/calendars/u/personal/A.ics": "uid-ä"})
	const PYTHON_CURSOR =
		"eyJ2IjoxLCJ0b2tlbnMiOnsicGVyc29uYWwiOiJodHRwOi8vc2FicmUuaW8vbnMvc3luYy80MiIsImxpXHUwMTYxdGEiOiJ0IFx1MDBmYyJ9LCJocmVmcyI6eyIvcmVtb3RlLnBocC9kYXYvY2FsZW5kYXJzL3UvcGVyc29uYWwvQS5pY3MiOiJ1aWQtXHUwMGU0In19";

	test("encodes byte-identically (ensure_ascii escapes, padding kept)", () => {
		expect(
			encodeCursor(
				{ personal: "http://sabre.io/ns/sync/42", lišta: "t ü" },
				{ "/remote.php/dav/calendars/u/personal/A.ics": "uid-ä" },
			),
		).toBe(PYTHON_CURSOR);
	});

	test("decodes a Python cursor", () => {
		expect(decodeCursor(PYTHON_CURSOR)).toEqual({
			personal: "http://sabre.io/ns/sync/42",
			lišta: "t ü",
		});
		expect(decodeHrefIndex(PYTHON_CURSOR)).toEqual({
			"/remote.php/dav/calendars/u/personal/A.ics": "uid-ä",
		});
	});

	test("padding survives a length that needs it", () => {
		const cursor = encodeCursor({ a: "b" });
		expect(cursor.endsWith("=")).toBe(true);
		expect(decodeCursor(cursor)).toEqual({ a: "b" });
	});

	test("DEL and control characters are escaped like json.dumps", () => {
		const cursor = encodeCursor({ k: "\u007f\u0001\n" });
		const json = Buffer.from(cursor, "base64url").toString("utf8");
		expect(json).toBe('{"v":1,"tokens":{"k":"\\u007f\\u0001\\n"},"hrefs":{}}');
	});

	test("astral characters escape as surrogate pairs", () => {
		const cursor = encodeCursor({ k: "😀" });
		const json = Buffer.from(cursor, "base64url").toString("utf8");
		expect(json).toContain('"\\ud83d\\ude00"');
	});
});

describe("href index", () => {
	test("absent or old cursor gives an empty index", () => {
		expect(decodeHrefIndex("")).toEqual({});
		expect(decodeHrefIndex(encodeCursor({ a: "t" }))).toEqual({});
		expect(decodeHrefIndex(b64url('{"v":1,"tokens":{}}'))).toEqual({});
		expect(decodeHrefIndex("junk!")).toEqual({});
	});

	test("round trips and drops non-string entries", () => {
		expect(decodeHrefIndex(encodeCursor({}, { "/x/A.ics": "uid-1" }))).toEqual({
			"/x/A.ics": "uid-1",
		});
		expect(
			decodeHrefIndex(
				b64url('{"v":1,"tokens":{},"hrefs":{"/a.ics":"u","/b.ics":3}}'),
			),
		).toEqual({ "/a.ics": "u" });
	});
});
