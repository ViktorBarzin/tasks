/**
 * Popup re-login (§I) — sign in WITHOUT losing the app.
 *
 * The full-page path (`$lib/relogin`) works, but it tears the app down: the
 * Replica reloads, in-flight UI state goes, and on iOS the app window leaves
 * for the SSO origin. A popup keeps the app running — it carries the
 * forward-auth round trip on its own, and the session cookie it earns belongs
 * to the same browsing context, so the app is simply authenticated again.
 *
 * The popup lands on `/api/signin`, which is gated by forward-auth and
 * excluded from the service worker's navigation handling — so it always
 * reaches Traefik→Authentik. The opener polls `/api/me` because that is the
 * only signal that survives every browser's popup quirks (a scripted
 * `window.close()` may be refused, and an out-of-context popup never talks
 * back at all).
 *
 * Two escapes, so the user is never stranded: a browser that refuses the popup
 * gets the full navigation immediately, and a popup that ends without a
 * session raises `signinFailed`, which turns the banner into the full-page
 * path on the next tap.
 */
import { writable } from 'svelte/store';

import { api } from './api';
import { startRelogin } from './relogin';
import { needsLogin, syncNow } from './sync';

/** Gated + service-worker-exempt by construction: reaching it proves a session. */
export const SIGNIN_PATH = '/api/signin';
export const SIGNIN_POLL_MS = 1_000;
/** Long enough for a password + MFA, short enough to not poll forever. */
export const SIGNIN_TIMEOUT_MS = 180_000;

/** A sign-in popup is open and being waited on. */
export const signinPending = writable(false);
/** The last popup attempt ended without a session — offer the full-page path. */
export const signinFailed = writable(false);

export type SignInOutcome = 'signed-in' | 'navigated' | 'abandoned';

export interface SignInDeps {
	openPopup(): Window | null;
	/** True once the session is live again. */
	probe(): Promise<boolean>;
	onSignedIn(): void;
	navigate(): void;
	wait(ms: number): Promise<void>;
}

const defaults: SignInDeps = {
	openPopup: () =>
		window.open(SIGNIN_PATH, 'tasks-signin', 'popup=yes,width=480,height=720'),
	probe: async () => {
		try {
			await api.me();
			return true;
		} catch {
			// Still walled (or briefly offline) — keep waiting.
			return false;
		}
	},
	onSignedIn: () => {
		needsLogin.set(false);
		void syncNow();
	},
	navigate: startRelogin,
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

export async function signIn(overrides: Partial<SignInDeps> = {}): Promise<SignInOutcome> {
	const deps = { ...defaults, ...overrides };
	signinFailed.set(false);

	const popup = deps.openPopup();
	if (!popup) {
		// Popup blocked: the full navigation is the only way to the login page.
		deps.navigate();
		return 'navigated';
	}

	signinPending.set(true);
	try {
		for (let waited = 0; waited < SIGNIN_TIMEOUT_MS; waited += SIGNIN_POLL_MS) {
			await deps.wait(SIGNIN_POLL_MS);
			// Probe BEFORE checking `closed`: the page closes itself the moment it
			// lands, so a closed popup is usually a SUCCESS, not a cancellation.
			if (await deps.probe()) {
				popup.close();
				deps.onSignedIn();
				return 'signed-in';
			}
			if (popup.closed) break;
		}
		signinFailed.set(true);
		return 'abandoned';
	} finally {
		signinPending.set(false);
	}
}
