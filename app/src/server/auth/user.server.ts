/**
 * Who is calling. Replaces backend/tasks_api/auth.py, which trusted
 * Authentik's forward-auth header `X-Authentik-Username`. The TypeScript build
 * never reads that header: both ingresses strip it (ADR-0001, Pilot / Cutover).
 *
 * Resolution order for a request:
 * 1. a Better Auth session cookie (browser; session.server.ts)
 * 2. an `Authorization: Bearer` Authentik JWT (CLIs, agents; tokens.server.ts)
 * 3. DEV_USER, outside production only (dev and tests)
 */
import { getSettings } from "../config.server";
import { ApiError } from "../http/errors.server";
import { getSessionUser } from "./session.server";
import { verifyBearerRequest } from "./tokens.server";

export interface OidcClaims {
	/** Authentik `sub` with sub_mode hashed_user_id. Stable; never an email. */
	sub: string;
	preferred_username: string;
}

export interface AuthUser {
	/** OIDC `sub`; null only for the DEV_USER fallback. */
	sub: string | null;
	/** Display name (`preferred_username`), returned as MeResponse.username. */
	username: string;
	/**
	 * The value stored in the `authentik_username` columns of
	 * connected_accounts and applied_ops. See accountKeyFor.
	 */
	accountKey: string;
	via: "session" | "token" | "dev";
}

/**
 * Which claim keys the database rows. Existing rows hold the Authentik
 * username from the forward-auth header. At cutover each row is mapped to the
 * user's `sub` (ADR-0001, Pilot / Identity); until then the TypeScript build
 * shares rows with the Python build by keying on `preferred_username`.
 * TASKS_ACCOUNT_KEY_CLAIM switches it: "preferred_username" (default) or "sub".
 */
export function accountKeyFor(claims: OidcClaims): string {
	return process.env.TASKS_ACCOUNT_KEY_CLAIM === "sub"
		? claims.sub
		: claims.preferred_username;
}

export function userFromClaims(
	claims: OidcClaims,
	via: "session" | "token",
): AuthUser {
	return {
		sub: claims.sub,
		username: claims.preferred_username,
		accountKey: accountKeyFor(claims),
		via,
	};
}

/** The caller, or null when the request carries no valid identity. */
export async function resolveUser(request: Request): Promise<AuthUser | null> {
	const fromSession = await getSessionUser(request);
	if (fromSession) return fromSession;
	const fromToken = await verifyBearerRequest(request);
	if (fromToken) return fromToken;
	const { devUser } = getSettings();
	if (devUser) {
		return { sub: null, username: devUser, accountKey: devUser, via: "dev" };
	}
	return null;
}

/** The caller, or a 401 `unauthorized` envelope. */
export async function requireUser(request: Request): Promise<AuthUser> {
	const user = await resolveUser(request);
	if (!user) throw new ApiError(401, "unauthorized", "not signed in");
	return user;
}
