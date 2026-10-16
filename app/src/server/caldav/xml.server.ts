/**
 * A small namespace-aware XML reader for WebDAV multistatus bodies, plus the
 * escaping the request bodies need. It replaces Python's xml.etree in
 * caldav_engine.py and the CalDAV test double, without adding a dependency.
 *
 * Scope: elements, attributes, namespace prefixes (including a default
 * namespace), character data, CDATA, the five predefined entities and numeric
 * character references. Comments and processing instructions are skipped.
 * A DOCTYPE is rejected (sabre never sends one, and refusing it rules out
 * entity expansion). Malformed input throws XmlParseError.
 *
 * `text` follows ElementTree: the character data before the first child
 * element. Line endings inside character data are normalised to LF, as every
 * conforming XML parser does (so CRLF-folded ICS in calendar-data arrives
 * with LF line endings, exactly as Python saw it).
 */

export class XmlParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "XmlParseError";
	}
}

export interface XmlElement {
	/** Namespace URI; "" for no namespace. */
	ns: string;
	/** Local name, without prefix. */
	name: string;
	/** Attributes by local name (namespaced attributes are not needed here). */
	attributes: Record<string, string>;
	children: XmlElement[];
	/** Character data before the first child element (ElementTree's `.text`). */
	text: string;
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

const ENTITIES: Record<string, string> = {
	lt: "<",
	gt: ">",
	amp: "&",
	quot: '"',
	apos: "'",
};

function decodeEntities(raw: string): string {
	return raw.replace(/&([^;&\s]*);?/g, (match, body: string) => {
		if (!match.endsWith(";")) {
			throw new XmlParseError(`unterminated entity reference: ${match}`);
		}
		if (body.startsWith("#x") || body.startsWith("#X")) {
			return codePoint(Number.parseInt(body.slice(2), 16), match);
		}
		if (body.startsWith("#")) {
			return codePoint(Number.parseInt(body.slice(1), 10), match);
		}
		const value = ENTITIES[body];
		if (value === undefined) {
			throw new XmlParseError(`undefined entity: ${match}`);
		}
		return value;
	});
}

function codePoint(value: number, match: string): string {
	if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff) {
		throw new XmlParseError(`invalid character reference: ${match}`);
	}
	return String.fromCodePoint(value);
}

const normaliseNewlines = (s: string) => s.replace(/\r\n?/g, "\n");

interface OpenElement {
	qname: string;
	element: XmlElement;
	scope: Map<string, string>;
	sawChild: boolean;
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const ATTRIBUTE = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function resolve(
	qname: string,
	scope: Map<string, string>,
	isAttribute: boolean,
): { ns: string; name: string } {
	const colon = qname.indexOf(":");
	if (colon === -1) {
		return { ns: isAttribute ? "" : (scope.get("") ?? ""), name: qname };
	}
	const prefix = qname.slice(0, colon);
	const ns = prefix === "xml" ? XML_NS : scope.get(prefix);
	if (ns === undefined) {
		throw new XmlParseError(`unbound namespace prefix: ${prefix}`);
	}
	return { ns, name: qname.slice(colon + 1) };
}

function parseStartTag(
	body: string,
	parentScope: Map<string, string>,
): { qname: string; element: XmlElement; scope: Map<string, string> } {
	const nameEnd = body.search(/\s|$/);
	const qname = body.slice(0, nameEnd);
	if (!NAME.test(qname)) throw new XmlParseError(`bad element name: ${qname}`);
	const rest = body.slice(nameEnd);
	const raw: [string, string][] = [];
	let consumed = rest;
	for (const m of rest.matchAll(ATTRIBUTE)) {
		const key = m[1] ?? "";
		const value = decodeEntities(normaliseNewlines(m[3] ?? m[4] ?? ""));
		raw.push([key, value]);
		consumed = consumed.replace(m[0], "");
	}
	if (consumed.trim() !== "") {
		throw new XmlParseError(`malformed attributes in <${qname}>`);
	}
	const scope = new Map(parentScope);
	for (const [key, value] of raw) {
		if (key === "xmlns") scope.set("", value);
		else if (key.startsWith("xmlns:")) scope.set(key.slice(6), value);
	}
	const attributes: Record<string, string> = {};
	for (const [key, value] of raw) {
		if (key === "xmlns" || key.startsWith("xmlns:")) continue;
		attributes[resolve(key, scope, true).name] = value;
	}
	const { ns, name } = resolve(qname, scope, false);
	return {
		qname,
		element: { ns, name, attributes, children: [], text: "" },
		scope,
	};
}

/** Parse a document and return its root element. Throws XmlParseError. */
export function parseXml(source: string): XmlElement {
	const xml = source.startsWith("﻿") ? source.slice(1) : source;
	const stack: OpenElement[] = [];
	let root: XmlElement | null = null;
	let pos = 0;

	const appendText = (text: string) => {
		const top = stack.at(-1);
		if (top === undefined) {
			if (text.trim() !== "") {
				throw new XmlParseError("character data outside the root element");
			}
			return;
		}
		if (!top.sawChild) top.element.text += text;
	};

	while (pos < xml.length) {
		const lt = xml.indexOf("<", pos);
		if (lt === -1) {
			appendText(decodeEntities(normaliseNewlines(xml.slice(pos))));
			break;
		}
		if (lt > pos) {
			appendText(decodeEntities(normaliseNewlines(xml.slice(pos, lt))));
		}
		if (xml.startsWith("<!--", lt)) {
			const end = xml.indexOf("-->", lt + 4);
			if (end === -1) throw new XmlParseError("unterminated comment");
			pos = end + 3;
		} else if (xml.startsWith("<![CDATA[", lt)) {
			const end = xml.indexOf("]]>", lt + 9);
			if (end === -1) throw new XmlParseError("unterminated CDATA section");
			if (stack.length === 0) {
				throw new XmlParseError("CDATA outside the root element");
			}
			appendText(normaliseNewlines(xml.slice(lt + 9, end)));
			pos = end + 3;
		} else if (xml.startsWith("<?", lt)) {
			const end = xml.indexOf("?>", lt + 2);
			if (end === -1) throw new XmlParseError("unterminated declaration");
			pos = end + 2;
		} else if (xml.startsWith("<!", lt)) {
			throw new XmlParseError("DOCTYPE and DTDs are not supported");
		} else if (xml.startsWith("</", lt)) {
			const end = xml.indexOf(">", lt);
			if (end === -1) throw new XmlParseError("unterminated end tag");
			const qname = xml.slice(lt + 2, end).trim();
			const top = stack.pop();
			if (top === undefined || top.qname !== qname) {
				throw new XmlParseError(`mismatched end tag </${qname}>`);
			}
			pos = end + 1;
		} else {
			const end = findTagEnd(xml, lt + 1);
			let body = xml.slice(lt + 1, end);
			const selfClosing = body.endsWith("/");
			if (selfClosing) body = body.slice(0, -1);
			const parent = stack.at(-1);
			if (parent === undefined && root !== null) {
				throw new XmlParseError("more than one root element");
			}
			const { qname, element, scope } = parseStartTag(
				body.trim(),
				parent?.scope ?? new Map(),
			);
			if (parent === undefined) {
				root = element;
			} else {
				parent.element.children.push(element);
				parent.sawChild = true;
			}
			if (!selfClosing) {
				stack.push({ qname, element, scope, sawChild: false });
			}
			pos = end + 1;
		}
	}
	if (stack.length > 0) {
		throw new XmlParseError(`unclosed element <${stack.at(-1)?.qname}>`);
	}
	if (root === null) throw new XmlParseError("no root element");
	return root;
}

/** Index of the `>` closing a start tag, skipping quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
	let quote: string | null = null;
	for (let i = from; i < xml.length; i++) {
		const ch = xml[i];
		if (quote !== null) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ">") {
			return i;
		}
	}
	throw new XmlParseError("unterminated start tag");
}

// ---------------------------------------------------------------- queries

export interface Step {
	ns: string;
	name: string;
	/** true: any descendant (ElementTree `.//`); false: a direct child. */
	deep?: boolean;
}

function matches(el: XmlElement, step: Step): boolean {
	return el.ns === step.ns && el.name === step.name;
}

function descendants(el: XmlElement, out: XmlElement[]): void {
	for (const child of el.children) {
		out.push(child);
		descendants(child, out);
	}
}

/**
 * ElementTree's findall for a path of steps, in document order. A step with
 * `deep` matches any descendant of the current node (`.//x`).
 */
export function findAll(el: XmlElement, path: readonly Step[]): XmlElement[] {
	let current = [el];
	for (const step of path) {
		const next: XmlElement[] = [];
		const seen = new Set<XmlElement>();
		for (const node of current) {
			let candidates: XmlElement[];
			if (step.deep) {
				candidates = [];
				descendants(node, candidates);
			} else {
				candidates = node.children;
			}
			for (const c of candidates) {
				if (matches(c, step) && !seen.has(c)) {
					seen.add(c);
					next.push(c);
				}
			}
		}
		current = next;
	}
	return current;
}

/** ElementTree's find: the first match in document order, or null. */
export function find(el: XmlElement, path: readonly Step[]): XmlElement | null {
	return findAll(el, path)[0] ?? null;
}

/** ElementTree `element.text or ""`, treating a missing element as "". */
export function textOf(el: XmlElement | null): string {
	return el?.text ?? "";
}

// ---------------------------------------------------------------- writing

/**
 * xml.sax.saxutils.escape: `&`, `<` and `>`. Quotes are left alone, which
 * is enough for element content (every value we write is element content).
 */
export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
