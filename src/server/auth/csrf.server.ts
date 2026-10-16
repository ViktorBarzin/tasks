/**
 * CSRF protection (ADR-0001, Browser security): an explicit check of where a
 * request comes from, applied by the request middleware in src/start.ts to
 * server functions, cookie-authenticated server routes and the SSE endpoint.
 *
 * A request is checked when it can change state (any method but GET, HEAD,
 * OPTIONS) or opens the SSE stream. Several sites share *.viktorbarzin.me,
 * so SameSite=Lax alone does not stop a sibling subdomain. A checked request
 * passes when:
 * - it carries a bearer token (no ambient credential; user.server.ts then
 *   takes the identity from the token only), or
 * - the browser says `Sec-Fetch-Site: same-origin`, or
 * - its `Origin` is one of PUBLIC_ORIGINS exactly (scheme, host and port), or
 * - it carries neither header nor a cookie (a non-browser client with nothing
 *   ambient to abuse).
 * Everything else is refused, including `Origin: null`.
 */
import { EVENTS_PATH } from "#/shared/contract";
import { csrfRejectionsTotal } from "./auth-metrics.server";
import { publicOrigins as configuredOrigins } from "./config.server";
import { bearerToken } from "./tokens.server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** PUBLIC_ORIGINS: comma-separated exact origins, e.g. "https://tasks.viktorbarzin.me". */
export function publicOrigins(): string[] {
	return configuredOrigins();
}

/** True for requests the origin check applies to. */
export function needsOriginCheck(request: Request): boolean {
	if (!SAFE_METHODS.has(request.method.toUpperCase())) return true;
	return new URL(request.url).pathname === EVENTS_PATH;
}

/**
 * True when the request may proceed: not a checked request, a bearer token,
 * a same-origin fetch, or an allowed Origin. `allowed` empty means the
 * request URL's own origin (dev, tests).
 */
export function isSameOriginRequest(
	request: Request,
	allowed: string[],
): boolean {
	if (!needsOriginCheck(request)) return true;
	if (bearerToken(request) !== null) return true;
	const headers = request.headers;
	const fetchSite = headers.get("sec-fetch-site");
	if (fetchSite !== null) return fetchSite === "same-origin";
	const origin = headers.get("origin");
	if (origin !== null) {
		const origins =
			allowed.length > 0 ? allowed : [new URL(request.url).origin];
		return origins.includes(origin);
	}
	return headers.get("cookie") === null;
}

/** The 403 sent for a refused request, in the API error envelope. */
export function csrfRejection(request: Request): Response | null {
	if (isSameOriginRequest(request, publicOrigins())) return null;
	csrfRejectionsTotal.inc();
	return Response.json(
		{ error: { code: "forbidden", message: "cross-origin request refused" } },
		{ status: 403 },
	);
}
