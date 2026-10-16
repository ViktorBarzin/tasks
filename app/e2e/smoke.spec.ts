import { expect, test } from "@playwright/test";

test("the shell renders, hydrates and logs no errors", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
	// The counter only moves once React has hydrated.
	await page.getByRole("button", { name: "Tap" }).click();
	await expect(page.getByTestId("taps")).toHaveText("1");
	expect(errors).toEqual([]);
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
