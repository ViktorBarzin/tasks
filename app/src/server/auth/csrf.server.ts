/**
 * CSRF protection (ADR-0001, Browser security): an explicit check of the
 * request's Origin against the app's public origin(s), applied to server
 * functions, cookie-authenticated server routes and the SSE endpoint.
 * Bearer-token requests carry no ambient credentials and are exempt.
 */
import { notImplemented } from "../not-implemented.server";

/** PUBLIC_ORIGINS: comma-separated exact origins, e.g. "https://tasks.viktorbarzin.me". */
export function publicOrigins(): string[] {
	return (process.env.PUBLIC_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
}

/** True when the request may proceed: a safe method, a bearer token, or an allowed Origin. */
export function isSameOriginRequest(
	request: Request,
	allowed: string[],
): boolean {
	void request;
	void allowed;
	return notImplemented("isSameOriginRequest");
}
