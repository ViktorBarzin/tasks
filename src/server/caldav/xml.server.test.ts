import { describe, expect, test } from "bun:test";

import {
	escapeXml,
	find,
	findAll,
	parseXml,
	textOf,
	XmlParseError,
} from "./xml.server";

const D = "DAV:";
const C = "urn:ietf:params:xml:ns:caldav";

describe("parseXml", () => {
	test("resolves prefixes and a default namespace", () => {
		const root = parseXml(
			'<?xml version="1.0"?>\n<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
				"<response><href>/a/</href><C:calendar-data>x</C:calendar-data></response>" +
				"</multistatus>",
		);
		expect(root).toMatchObject({ ns: D, name: "multistatus" });
		expect(
			textOf(
				find(root, [
					{ ns: D, name: "response" },
					{ ns: D, name: "href" },
				]),
			),
		).toBe("/a/");
		expect(
			textOf(find(root, [{ ns: C, name: "calendar-data", deep: true }])),
		).toBe("x");
	});

	test("prefixes can be redeclared on inner elements", () => {
		const root = parseXml(
			'<x:a xmlns:x="DAV:"><x:b xmlns:x="urn:other"><x:c/></x:b></x:a>',
		);
		expect(find(root, [{ ns: "urn:other", name: "b" }])).not.toBeNull();
		expect(find(root, [{ ns: "DAV:", name: "b" }])).toBeNull();
	});

	test("decodes entities, character references and CDATA", () => {
		const root = parseXml(
			"<a>1 &lt; 2 &amp;&amp; &#8220;q&#x201D; &quot;&apos;<![CDATA[<raw>&amp;]]></a>",
		);
		expect(root.text).toBe("1 < 2 && “q” \"'<raw>&amp;");
	});

	test("normalises CRLF in character data to LF, as expat does", () => {
		const root = parseXml("<a>BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n</a>");
		expect(root.text).toBe("BEGIN:VCALENDAR\nEND:VCALENDAR\n");
		expect(parseXml("<a>x&#13;\ny</a>").text).toBe("x\r\ny");
	});

	test("text is the data before the first child (ElementTree .text)", () => {
		const root = parseXml("<a>head<!-- c -->more<b>in</b>tail</a>");
		expect(root.text).toBe("headmore");
		expect(root.children[0]?.text).toBe("in");
	});

	test("attributes, quoted '>' and self-closing tags", () => {
		const root = parseXml(
			`<c:set xmlns:c="${C}"><c:comp name="VTODO"/><c:comp name='a>b' /></c:set>`,
		);
		const comps = findAll(root, [{ ns: C, name: "comp" }]);
		expect(comps.map((c) => c.attributes.name)).toEqual(["VTODO", "a>b"]);
	});

	test.each([
		["unclosed", "<a><b></a>"],
		["two roots", "<a/><b/>"],
		["unbound prefix", "<x:a/>"],
		["undefined entity", "<a>&nbsp;</a>"],
		["bare ampersand", "<a>fish & chips</a>"],
		["doctype", '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>'],
		["not xml", "not xml at all"],
		["empty", ""],
	])("rejects %s", (_label, source) => {
		expect(() => parseXml(source)).toThrow(XmlParseError);
	});
});

describe("findAll", () => {
	const root = parseXml(
		`<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:x>1</d:x></d:prop></d:propstat>` +
			`<d:propstat><d:prop><d:x>2</d:x></d:prop></d:propstat></d:response></d:multistatus>`,
	);

	test("deep steps return matches in document order", () => {
		const xs = findAll(root, [
			{ ns: D, name: "propstat", deep: true },
			{ ns: D, name: "prop" },
			{ ns: D, name: "x" },
		]);
		expect(xs.map((x) => x.text)).toEqual(["1", "2"]);
	});

	test("child steps do not descend", () => {
		expect(findAll(root, [{ ns: D, name: "propstat" }])).toEqual([]);
	});
});

describe("escapeXml", () => {
	test("matches xml.sax.saxutils.escape", () => {
		expect(escapeXml(`a&b<c>d"e'`)).toBe(`a&amp;b&lt;c&gt;d"e'`);
	});
});
