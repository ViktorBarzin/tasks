/**
 * Browser sessions: Better Auth with its generic OAuth plugin against
 * Authentik, and the Drizzle adapter (sessions in this app's database).
 * ADR-0001, Identity and access:
 * - access tokens valid for 15 minutes at most, sessions capped at 7 days,
 *   and each refresh re-checks `Tasks Users` membership with Authentik;
 * - `prompt=login` when the Authentik session is the anonymous `guest`;
 * - host-only `__Host-` cookies; `trustedOrigins` lists exact origins;
 * - no `offline_access` scope on web sign-in;
 * - BETTER_AUTH_SECRET and the OIDC client secret come from Vault KV via ESO.
 *
 * Better Auth's own tables arrive as a new additive Drizzle migration.
 * Sign-in runs in a popup and is detected by a 401 (tasks ADR-0003, ADR-0004).
 */
import { notImplemented } from "../not-implemented.server";
import type { AuthUser } from "./user.server";

/** The signed-in user from the session cookie, or null when there is none or it is invalid. */
export async function getSessionUser(
	request: Request,
): Promise<AuthUser | null> {
	if (!request.headers.get("cookie")) return null;
	return notImplemented("getSessionUser");
}

/** Better Auth's request handler, mounted at /api/auth/$ (sign-in, callback, sign-out). */
export async function handleAuthRequest(request: Request): Promise<Response> {
	void request;
	return notImplemented("handleAuthRequest");
}
