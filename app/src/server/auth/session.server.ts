/**
 * Browser sessions: Better Auth (auth.server.ts) plus the two endpoints that
 * wrap its OAuth flow.
 *
 * - GET /api/auth/start?return=<path>[&login=1] begins the OAuth flow and
 *   redirects to Authentik; `login=1` adds `prompt=login`.
 * - GET /api/auth/finish?return=<path> is where Better Auth lands after the
 *   callback; it redirects to `return`.
 * - Everything else under /api/auth goes to Better Auth's handler
 *   (callback, sign-out, get-session, error page).
 *
 * The sign-in popup (tasks ADR-0004) opens /api/signin, which starts this
 * flow when there is no session and closes itself once there is one. A
 * lapsed session shows up as a 401 from /api (ADR-0001, Pilot / Client
 * continuity), not as a redirect.
 */
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client.server";
import { ApiError, errorResponse } from "../http/errors.server";
import { getLogger } from "../logging.server";
import {
	ERROR_PATH,
	finishUrl,
	getAuth,
	getAuthWithProvider,
	LOGIN_PARAM,
	PROVIDER_ID,
	safeReturnPath,
	startUrl,
} from "./auth.server";
import { getAccessSettings } from "./config.server";
import { accountKeyForSubject } from "./identity.server";
import { currentMembership, readMemberCheck } from "./membership.server";
import { authAccount } from "./schema.server";
import type { AuthUser } from "./user.server";

const log = getLogger("tasks.session");

/** The signed-in user from the session cookie, or null when there is none or it is invalid. */
export async function getSessionUser(
	request: Request,
): Promise<AuthUser | null> {
	if (!request.headers.get("cookie")) return null;
	const auth = getAuth();
	if (!auth) return null;
	const found = await auth.api.getSession({
		headers: request.headers,
		query: { disableCookieCache: true, disableRefresh: true },
	});
	if (!found) return null;

	const db = getDb();
	const [account] = await db
		.select({ sub: authAccount.accountId })
		.from(authAccount)
		.where(
			and(
				eq(authAccount.userId, found.user.id),
				eq(authAccount.providerId, PROVIDER_ID),
			),
		)
		.limit(1);
	if (!account) return null;
	const sub = account.sub;
	// The username the verified id_token carried at the last sign-in.
	const username =
		(await readMemberCheck(db, sub))?.username ?? found.user.name;
	if (username === getAccessSettings().guestUsername) return null;

	const accountKey = await accountKeyForSubject(db, sub, username);
	const membership = await currentMembership(db, sub, username);
	return { sub, username, accountKey, via: "session", ...membership };
}

/** Copy every Set-Cookie from Better Auth's headers onto a response. */
function withCookies(response: Response, from: Headers): Response {
	for (const cookie of from.getSetCookie())
		response.headers.append("set-cookie", cookie);
	return response;
}

function redirect(location: string, extra?: HeadersInit): Response {
	const headers = new Headers(extra);
	headers.set("location", location);
	headers.set("cache-control", "no-store");
	return new Response(null, { status: 302, headers });
}

/**
 * A redirect into sign-in that comes back to `returnTo`, or null when OIDC
 * sign-in is not configured (dev and tests on DEV_USER).
 */
export function signInRedirect(returnTo: string): Response | null {
	if (!getAuth()) return null;
	return redirect(startUrl(returnTo, false));
}

/** GET /api/auth/start: redirect to Authentik's authorization endpoint. */
export async function startSignIn(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const returnTo = safeReturnPath(url.searchParams.get("return"));
	const forceLogin = url.searchParams.has(LOGIN_PARAM);
	const auth = await getAuthWithProvider();
	if (!auth) {
		throw new ApiError(
			503,
			"auth_unavailable",
			"sign-in is not available right now",
		);
	}
	const { headers, response } = await auth.api.signInSocial({
		body: {
			provider: PROVIDER_ID,
			callbackURL: finishUrl(returnTo, forceLogin),
			errorCallbackURL: ERROR_PATH,
			disableRedirect: true,
			...(forceLogin ? { additionalParams: { prompt: "login" } } : {}),
		},
		headers: request.headers,
		returnHeaders: true,
	});
	if (!response.url)
		throw new Error("Better Auth returned no authorization URL");
	return withCookies(redirect(response.url), headers);
}

/** GET /api/auth/finish: Better Auth set the session cookie; go where the user was going. */
export async function finishSignIn(request: Request): Promise<Response> {
	const url = new URL(request.url);
	return redirect(safeReturnPath(url.searchParams.get("return")));
}

/** Better Auth's request handler, mounted at /api/auth/$ (callback, sign-out, session, error). */
export async function handleAuthRequest(request: Request): Promise<Response> {
	const auth = getAuth();
	if (!auth)
		return errorResponse(404, "not_found", "sign-in is not configured");
	const response = await auth.handler(request);
	if (response.status >= 500) {
		log.warning("auth endpoint failed", {
			path: new URL(request.url).pathname,
			status: response.status,
		});
	}
	return response;
}
