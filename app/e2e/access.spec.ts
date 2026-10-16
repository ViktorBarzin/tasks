import { expect, test } from "@playwright/test";

/**
 * The pending and approval pages hydrate in a real browser without pulling a
 * server-only module (Better Auth, the Postgres driver) into the client
 * bundle. The full sign-in, request and approve flow runs in bun test against
 * the mock Authentik (src/server/auth/auth-flow.server.test.ts).
 */
function collectErrors(page: import("@playwright/test").Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	return errors;
}

test("the pending page offers sign-in when signed out and hydrates cleanly", async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto("/pending");
	const signIn = page.getByRole("link", { name: "Sign in" });
	await expect(signIn).toBeVisible();
	await expect(signIn).toHaveAttribute("href", "/api/auth/start?return=%2Fpending");
	expect(errors).toEqual([]);
});

test("the approval page refuses a signed-out visitor", async ({ page }) => {
	await page.goto("/admin/requests");
	await expect(page.getByRole("alert")).toContainText("not signed in");
});

test("a cross-site POST to a server function is refused", async ({ request }) => {
	const res = await request.post("/_serverFn/anything", {
		headers: { origin: "https://evil.example", cookie: "__Host-tasks.session_token=x" },
	});
	expect(res.status()).toBe(403);
});
