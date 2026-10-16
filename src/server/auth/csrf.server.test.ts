import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { isSameOriginRequest, needsOriginCheck } from "./csrf.server";

const PUBLIC = "https://tasks.viktorbarzin.me";

function req(
	method: string,
	path: string,
	headers: Record<string, string> = {},
): Request {
	return new Request(`http://10.0.0.5:3000${path}`, { method, headers });
}

describe("needsOriginCheck", () => {
	test.each(["POST", "PUT", "PATCH", "DELETE"])("%s is checked", (method) => {
		expect(needsOriginCheck(req(method, "/api/ops"))).toBe(true);
	});

	test("safe methods are not, except the SSE stream", () => {
		expect(needsOriginCheck(req("GET", "/api/sync"))).toBe(false);
		expect(needsOriginCheck(req("HEAD", "/"))).toBe(false);
		expect(needsOriginCheck(req("GET", "/api/events"))).toBe(true);
	});
});

describe("isSameOriginRequest", () => {
	const cookie = { cookie: "__Host-tasks.session_token=abc" };

	test("the public origin passes", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/api/ops", { ...cookie, origin: PUBLIC }),
				[PUBLIC],
			),
		).toBe(true);
	});

	test("Sec-Fetch-Site same-origin passes and decides before Origin", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/_serverFn/x", {
					...cookie,
					"sec-fetch-site": "same-origin",
				}),
				[PUBLIC],
			),
		).toBe(true);
		expect(
			isSameOriginRequest(
				req("POST", "/_serverFn/x", {
					...cookie,
					"sec-fetch-site": "same-site",
					origin: PUBLIC,
				}),
				[PUBLIC],
			),
		).toBe(false);
	});

	test.each([
		["a sibling subdomain", "https://pages.viktorbarzin.me"],
		["http instead of https", "http://tasks.viktorbarzin.me"],
		["another port", "https://tasks.viktorbarzin.me:8443"],
		["a suffix trick", "https://tasks.viktorbarzin.me.evil.example"],
		["an opaque origin", "null"],
	])("refuses %s", (_name, origin) => {
		expect(
			isSameOriginRequest(req("POST", "/api/ops", { ...cookie, origin }), [
				PUBLIC,
			]),
		).toBe(false);
	});

	test("the SSE stream needs the check too", () => {
		expect(
			isSameOriginRequest(
				req("GET", "/api/events", {
					...cookie,
					"sec-fetch-site": "cross-site",
				}),
				[PUBLIC],
			),
		).toBe(false);
		expect(
			isSameOriginRequest(
				req("GET", "/api/events", {
					...cookie,
					"sec-fetch-site": "same-origin",
				}),
				[PUBLIC],
			),
		).toBe(true);
	});

	test("a bearer token carries no ambient credential and passes", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/api/ops", {
					authorization: "Bearer eyJ.a.b",
					origin: "https://evil.example",
				}),
				[PUBLIC],
			),
		).toBe(true);
	});

	test("no browser headers: passes without a cookie, refused with one", () => {
		expect(isSameOriginRequest(req("POST", "/api/ops"), [PUBLIC])).toBe(true);
		expect(isSameOriginRequest(req("POST", "/api/ops", cookie), [PUBLIC])).toBe(
			false,
		);
	});

	test("with no PUBLIC_ORIGINS configured, the request's own origin is the allow-list", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/api/ops", { ...cookie, origin: "http://10.0.0.5:3000" }),
				[],
			),
		).toBe(true);
	});

	test("property: any origin outside the list is refused for a cookie POST", () => {
		fc.assert(
			fc.property(fc.webUrl(), (url) => {
				const origin = new URL(url).origin;
				fc.pre(origin !== PUBLIC);
				return !isSameOriginRequest(
					req("POST", "/api/ops", { ...cookie, origin }),
					[PUBLIC],
				);
			}),
		);
	});
});
