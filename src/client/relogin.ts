/**
 * Full-page sign-in: the path that always works (tasks ADR-0003, ADR-0004).
 * signin.ts tries a popup first; this runs when the browser refuses the popup
 * or the popup ended without a session.
 *
 * In the Svelte build the whole origin sat behind forward-auth, so re-login
 * was a navigation to `/?relogin=1` that the service worker let through to
 * the network. The TypeScript build serves the app shell without a session
 * and answers /api with a 401, so signing in means reaching the OIDC flow,
 * which starts at SIGNIN_PATH. That path is under /api, which the service
 * worker never answers, so the navigation always reaches the server, and
 * `return_to` brings the window back to the screen it left.
 *
 * ADR-0003 kept one case from that design: tapping "sign in" with no signal
 * must not strand an installed PWA on the browser's error page. A navigation
 * the service worker does not answer would do exactly that, so the server is
 * probed first and the app stays put when it is unreachable.
 */
import { CLIENT_ID_HEADER, SIGNIN_PATH } from "#/shared/contract";

import { clientId } from "./api";

/** Where the server sends the window after sign-in (a same-origin path). */
export const RETURN_TO_PARAM = "return_to";

/** The Svelte build's re-login marker; dropped if a stale URL still carries it. */
const LEGACY_RELOGIN_PARAM = "relogin";

/** The sign-in URL that returns to the screen at `currentHref` (hash dropped). */
export function signinPageUrl(currentHref: string): string {
	const current = new URL(currentHref);
	current.searchParams.delete(LEGACY_RELOGIN_PARAM);
	const back = current.pathname + current.search;
	return `${SIGNIN_PATH}?${new URLSearchParams({ [RETURN_TO_PARAM]: back })}`;
}

export interface ReloginDeps {
	href: string;
	/** True when the server answers at all (any status). */
	reachable(): Promise<boolean>;
	assign(url: string): void;
}

const defaults = (): ReloginDeps => ({
	href: window.location.href,
	reachable: async () => {
		try {
			// /api/me has no side effects; a 401 still proves the network is up.
			await fetch("/api/me", {
				cache: "no-store",
				credentials: "same-origin",
				// This tab's id, as on every /api request (src/client/api.ts).
				headers: { [CLIENT_ID_HEADER]: clientId() },
			});
			return true;
		} catch {
			return false;
		}
	},
	assign: (url) => window.location.assign(url),
});

export type ReloginOutcome = "navigated" | "offline";

/** Leave for the sign-in flow, or stay in the app when there is no signal. */
export async function startRelogin(
	overrides: Partial<ReloginDeps> = {},
): Promise<ReloginOutcome> {
	const deps = { ...defaults(), ...overrides };
	if (!(await deps.reachable())) return "offline";
	deps.assign(signinPageUrl(deps.href));
	return "navigated";
}
