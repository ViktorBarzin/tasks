import { expect, test } from "@playwright/test";

/**
 * The built app in a real browser: the shell renders, hydrates and logs no
 * errors (a server-only module leaking into the client bundle shows up here
 * and nowhere else), and the server's own endpoints answer like FastAPI's.
 */
test("the app hydrates, renders Home from the stubbed API and logs no errors", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	await page.route("**/api/me", (route) =>
		route.fulfill({ json: { username: "e2e", connected: true } }),
	);
	await page.route("**/api/events", (route) =>
		route.fulfill({
			contentType: "text/event-stream",
			body: "retry: 60000\n\n",
		}),
	);
	await page.route("**/api/sync**", (route) =>
		route.fulfill({
			json: {
				cursor: "c",
				full: true,
				lists: [
					{
						id: "l-a",
						name: "Alpha",
						order: 0,
						sort_mode: null,
						deleted: false,
					},
					{
						id: "l-b",
						name: "Bravo",
						order: 1,
						sort_mode: null,
						deleted: false,
					},
				],
				tasks: [],
			},
		}),
	);

	await page.goto("/");
	await expect(page.locator(".list-name")).toHaveText(["Alpha", "Bravo"]);
	// Edit mode only toggles once React has hydrated.
	await page.getByRole("button", { name: "Edit" }).click();
	await expect(page.locator("[data-drag-handle]")).toHaveCount(2);
	expect(errors).toEqual([]);
});

test("the server answers every page with the same client-only shell", async ({
	request,
}) => {
	const home = await request.get("/");
	const deep = await request.get("/list/l-a");
	expect(home.status()).toBe(200);
	expect(deep.status()).toBe(200);
	// No screen is server-rendered: the shell's body is the boot spinner only.
	for (const body of [await home.text(), await deep.text()]) {
		expect(body).toContain('class="app-shell"');
		expect(body).not.toContain("list-name");
	}
});

test("the service worker and web manifest are served at the Svelte build's URLs", async ({
	request,
}) => {
	const sw = await request.get("/service-worker.js");
	expect(sw.status()).toBe(200);
	expect(sw.headers()["content-type"]).toContain("javascript");
	const manifest = await request.get("/manifest.webmanifest");
	expect(manifest.status()).toBe(200);
	expect((await manifest.json()).name).toBe("Tasks");
});

test("healthz answers like the FastAPI app", async ({ request }) => {
	const res = await request.get("/healthz");
	expect(res.status()).toBe(200);
	expect(await res.json()).toEqual({ status: "ok" });
});

test("/api without an identity is a 401 envelope", async ({ request }) => {
	const res = await request.get("/api/me");
	expect(res.status()).toBe(401);
	expect((await res.json()).error.code).toBe("unauthorized");
});
