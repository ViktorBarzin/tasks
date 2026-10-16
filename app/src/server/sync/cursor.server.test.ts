/**
 * Port of backend/tests/test_cursor.py, plus byte-compatibility with cursors
 * Python minted (devices updating from the Python build send them back).
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { decodeCursor, decodeHrefIndex, encodeCursor } from "./cursor.server";

const b64 = (text: string) =>
	Buffer.from(text, "utf8")
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_");

describe("cursor", () => {
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

	test("cursor is url-safe ASCII with padding kept", () => {
		const cursor = encodeCursor({ "lišta/á": "token with spaces & ?=" });
		expect(cursor).toBe(cursor.trim());
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+=*$/);
		expect(cursor.length % 4).toBe(0);
	});

	test("empty cursor means full snapshot", () => {
		expect(decodeCursor("")).toBeNull();
	});

	test("garbage is null, not an error", () => {
		expect(decodeCursor("not-base64 at all!!")).toBeNull();
		expect(decodeCursor(b64("not json"))).toBeNull();
		expect(decodeCursor(b64('"a json string"'))).toBeNull();
	});

	test("wrong version is null", () => {
		expect(decodeCursor(b64(JSON.stringify({ v: 0, tokens: {} })))).toBeNull();
	});

	test("non-string tokens are null", () => {
		expect(
			decodeCursor(b64(JSON.stringify({ v: 1, tokens: { personal: 42 } }))),
		).toBeNull();
		expect(decodeCursor(b64(JSON.stringify({ v: 1 })))).toBeNull();
	});

	test("any token map round trips", () => {
		fc.assert(
			fc.property(
				fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
				(tokens) => {
					expect(decodeCursor(encodeCursor(tokens))).toEqual(tokens);
				},
			),
		);
	});

	test("decode never throws", () => {
		fc.assert(
			fc.property(fc.string(), (junk) => {
				const result = decodeCursor(junk);
				expect(result === null || typeof result === "object").toBe(true);
				decodeHrefIndex(junk);
			}),
		);
	});
});

describe("byte compatibility with Python's cursor.py", () => {
	// python3 -c 'import base64,json;print(base64.urlsafe_b64encode(json.dumps(
	//   {"v":1,"tokens":{"personal":"http://sabre.io/ns/sync/42","lišta":"t"},
	//    "hrefs":{"/x/Á.ics":"uid-1"}},separators=(",",":")).encode()).decode())'
	const PYTHON_CURSOR =
		"eyJ2IjoxLCJ0b2tlbnMiOnsicGVyc29uYWwiOiJodHRwOi8vc2FicmUuaW8vbnMvc3luYy80MiIsImxpXHUwMTYxdGEiOiJ0In0sImhyZWZzIjp7Ii94L1x1MDBjMS5pY3MiOiJ1aWQtMSJ9fQ==";

	test("encodes exactly as Python does (ensure_ascii, padding, key order)", () => {
		expect(
			encodeCursor(
				{ personal: "http://sabre.io/ns/sync/42", lišta: "t" },
				{ "/x/Á.ics": "uid-1" },
			),
		).toBe(PYTHON_CURSOR);
	});

	test("decodes a cursor Python minted", () => {
		expect(decodeCursor(PYTHON_CURSOR)).toEqual({
			personal: "http://sabre.io/ns/sync/42",
			lišta: "t",
		});
		expect(decodeHrefIndex(PYTHON_CURSOR)).toEqual({ "/x/Á.ics": "uid-1" });
	});

	test("an old cursor without hrefs has an empty index", () => {
		const old = b64(JSON.stringify({ v: 1, tokens: { work: "t" } }));
		expect(decodeCursor(old)).toEqual({ work: "t" });
		expect(decodeHrefIndex(old)).toEqual({});
	});

	test("the href index keeps only string pairs", () => {
		const mixed = b64(
			JSON.stringify({ v: 1, tokens: {}, hrefs: { a: "uid", b: 5 } }),
		);
		expect(decodeHrefIndex(mixed)).toEqual({ a: "uid" });
	});
});
