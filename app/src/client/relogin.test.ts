import { describe, expect, it, mock } from "bun:test";

import { SIGNIN_PATH } from "#/shared/contract";

import { RETURN_TO_PARAM, signinPageUrl, startRelogin } from "./relogin";

describe("signinPageUrl", () => {
	it("sends the window to the sign-in endpoint, which the service worker never answers", () => {
		expect(signinPageUrl("https://tasks.viktorbarzin.me/")).toBe(
			`${SIGNIN_PATH}?${RETURN_TO_PARAM}=%2F`,
		);
	});

	it("keeps the current screen so sign-in returns where the user was", () => {
		expect(signinPageUrl("https://tasks.viktorbarzin.me/list/l-a")).toBe(
			`${SIGNIN_PATH}?${RETURN_TO_PARAM}=%2Flist%2Fl-a`,
		);
	});

	it("preserves the screen's own query", () => {
		expect(
			signinPageUrl("https://tasks.viktorbarzin.me/view/today?filter=flagged"),
		).toBe(
			`${SIGNIN_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent("/view/today?filter=flagged")}`,
		);
	});

	it("drops a hash: the sign-in round trip never carries it back", () => {
		expect(signinPageUrl("https://tasks.viktorbarzin.me/list/l-a#task-3")).toBe(
			`${SIGNIN_PATH}?${RETURN_TO_PARAM}=%2Flist%2Fl-a`,
		);
	});

	it("drops a stale ?relogin=1 marker left by the Svelte build", () => {
		expect(
			signinPageUrl("https://tasks.viktorbarzin.me/list/l-a?relogin=1"),
		).toBe(`${SIGNIN_PATH}?${RETURN_TO_PARAM}=%2Flist%2Fl-a`);
	});
});

describe("startRelogin", () => {
	it("navigates once the server is reachable", async () => {
		const assign = mock((_url: string) => {});
		const outcome = await startRelogin({
			href: "https://tasks.viktorbarzin.me/list/l-a",
			reachable: async () => true,
			assign,
		});
		expect(outcome).toBe("navigated");
		expect(assign).toHaveBeenCalledWith(
			`${SIGNIN_PATH}?${RETURN_TO_PARAM}=%2Flist%2Fl-a`,
		);
	});

	it("stays in the app with no signal instead of landing on a browser error page", async () => {
		const assign = mock((_url: string) => {});
		const outcome = await startRelogin({
			href: "https://tasks.viktorbarzin.me/",
			reachable: async () => false,
			assign,
		});
		expect(outcome).toBe("offline");
		expect(assign).not.toHaveBeenCalled();
	});
});
