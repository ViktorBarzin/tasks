import { describe, expect, test } from "bun:test";

import { withFrameDenial } from "./headers.server";

describe("withFrameDenial", () => {
	test("adds frame-ancestors 'none' and X-Frame-Options DENY", () => {
		const res = withFrameDenial(new Response("x"));
		expect(res.headers.get("content-security-policy")).toBe(
			"frame-ancestors 'none'",
		);
		expect(res.headers.get("x-frame-options")).toBe("DENY");
	});

	test("keeps a policy the route set itself", () => {
		const res = withFrameDenial(
			new Response("x", {
				headers: { "content-security-policy": "default-src 'self'" },
			}),
		);
		expect(res.headers.get("content-security-policy")).toBe(
			"default-src 'self'",
		);
	});

	test("copies a response whose headers are immutable", async () => {
		const immutable = Response.redirect("http://app.invalid/x", 302);
		const res = withFrameDenial(immutable);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("http://app.invalid/x");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
	});
});
