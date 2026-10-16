import { expect, installedPwa, test } from "../fixtures/pwa";

/**
 * /pending and /admin/* render outside AppGate and load through server
 * functions, so they need the network. The worker must let their navigations
 * through: the precached shell is the response to `/`, and hydrating it on
 * these routes is a React hydration mismatch (error #418).
 */
for (const path of ["/pending", "/admin/requests"]) {
	test(`an installed PWA loads ${path} from the network and hydrates cleanly`, async ({
		page,
		pwa,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.goto(`${pwa.appUrl}/`);
		await installedPwa(page, "/");

		await page.goto(`${pwa.appUrl}${path}`);
		await expect(page.locator("main h1")).toBeVisible();
		await page.waitForTimeout(500);
		expect(errors).toEqual([]);
	});
}
