/**
 * Who is calling. The app never reads Authentik's forward-auth header
 * `X-Authentik-Username`, and the ingress strips it (ADR-0001).
 *
 * Resolution order for a request:
 * 1. `Authorization: Bearer` present: an Authentik JWT (CLIs, agents;
 *    tokens.server.ts), and nothing else. A refused token is a 401 even when
 *    a cookie is present, so a forged header cannot ride on a cookie.
 * 2. a Better Auth session cookie (browser; session.server.ts)
 * 3. DEV_USER, outside production only (dev and tests)
 *
 * Users are keyed on the OIDC `sub`; `accountKey` is the value the data rows
 * use, found through the identity bridge (identity.server.ts).
 */
import { getSettings } from "../config.server";
import { getDb } from "../db/client.server";
import { ApiError } from "../http/errors.server";
import { getAccessSettings } from "./config.server";
import { accountKeyForSubject } from "./identity.server";
import {
	currentMembership,
	readMemberCheck,
	recordClaimedGroups,
} from "./membership.server";
import { getSessionUser } from "./session.server";
import {
	bearerToken,
	type VerifiedToken,
	verifyBearerRequest,
} from "./tokens.server";

export interface AuthUser {
	/** OIDC `sub`; null only for the DEV_USER fallback. */
	sub: string | null;
	/** Display name (`preferred_username`), returned as MeResponse.username. */
	username: string;
	/**
	 * The value stored in the `authentik_username` columns of
	 * connected_accounts and applied_ops (identity_links).
	 */
	accountKey: string;
	via: "session" | "token" | "dev";
	/** In Tasks Users, Tasks Admins or Tasks Agents, as of the last check (<= 15 min old). */
	member: boolean;
	/** In Tasks Admins. */
	admin: boolean;
}

async function userFromToken(token: VerifiedToken): Promise<AuthUser | null> {
	if (token.preferredUsername === getAccessSettings().guestUsername)
		return null;
	const db = getDb();
	if (!(await readMemberCheck(db, token.sub))) {
		await recordClaimedGroups(
			db,
			token.sub,
			token.preferredUsername,
			token.groups,
			"token",
		);
	}
	const accountKey = await accountKeyForSubject(
		db,
		token.sub,
		token.preferredUsername,
	);
	const membership = await currentMembership(
		db,
		token.sub,
		token.preferredUsername,
	);
	return {
		sub: token.sub,
		username: token.preferredUsername,
		accountKey,
		via: "token",
		...membership,
	};
}

/** The caller, or null when the request carries no valid identity. Membership is not enforced here. */
export async function resolveUser(request: Request): Promise<AuthUser | null> {
	if (bearerToken(request) !== null || request.headers.has("authorization")) {
		const token = await verifyBearerRequest(request);
		return token ? userFromToken(token) : null;
	}
	const fromSession = await getSessionUser(request);
	if (fromSession) return fromSession;
	const { devUser } = getSettings();
	if (devUser) {
		return {
			sub: null,
			username: devUser,
			accountKey: devUser,
			via: "dev",
			member: true,
			admin: true,
		};
	}
	return null;
}

/**
 * The caller, or a 401 `unauthorized` envelope; a signed-in person who is not
 * a member yet gets a 403 `access_pending` (the UI shows the pending page).
 */
export async function requireUser(request: Request): Promise<AuthUser> {
	const user = await resolveUser(request);
	if (!user) throw new ApiError(401, "unauthorized", "not signed in");
	if (!user.member)
		throw new ApiError(403, "access_pending", "waiting for approval");
	return user;
}
