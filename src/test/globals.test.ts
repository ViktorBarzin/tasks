import { expect, test } from "bun:test";

// The preload must leave Bun's web globals in place for server code.
test("server code sees Bun's Response, not happy-dom's", async () => {
	const res = new Response(JSON.stringify({ ok: true }), {
		headers: { "content-type": "application/json" },
	});
	expect(await res.json()).toEqual({ ok: true });
	expect(Response.name).toBe("Response");
	expect(typeof Bun.serve).toBe("function");
});

test("component tests get a DOM", () => {
	document.body.innerHTML = "<p>hello</p>";
	expect(document.querySelector("p")?.textContent).toBe("hello");
});
