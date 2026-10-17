import { createMiddleware, createStart } from "@tanstack/react-start";
import { getLogger } from "@viktorbarzin/log";
import { createHandlerLabeler, observeRequest } from "@viktorbarzin/metrics";
import { withFrameDenial } from "@viktorbarzin/runtime";

import { appAuth } from "#/server/auth/auth.server";

const accessLog = getLogger("tasks.http");

/**
 * The `handler` label: known routes by name, everything else folded into a
 * few buckets so the label set stays small.
 */
const label = createHandlerLabeler({
	known: [
		"/api/me",
		"/api/onboard",
		"/api/sync",
		"/api/ops",
		"/api/signin",
		"/api/events",
		"/healthz",
	],
});

/**
 * Every request through the Start handler: Bun's idle timeout raised from
 * 10 s (a slow CalDAV answer must reach the client; /api/events lifts it
 * further), in-flight tracking for graceful shutdown, request metrics and one
 * access-log line for /api calls. Server-only: Start strips `.server()` bodies
 * and the imports only they use from the client bundle.
 */
const observe = createMiddleware().server(async ({ request, next }) => {
	const done = observeRequest(request, { label, accessLog });
	let status = 500;
	try {
		const result = await next();
		status = result.response.status;
		return result;
	} finally {
		done(status);
	}
});

/**
 * The explicit CSRF check (ADR-0001, Browser security; @viktorbarzin/auth):
 * state-changing requests and the SSE stream must come from a public origin.
 * Covers server functions, server routes and /api/events alike.
 */
const csrf = createMiddleware().server(async ({ request, next }) => {
	const rejection = appAuth.csrfRejection(request);
	if (rejection) return rejection;
	return next();
});
// Tell Start this is the app's CSRF middleware, so it does not warn in dev.
Object.defineProperty(csrf, Symbol.for("tanstack-start:csrf-middleware"), {
	value: true,
});

/**
 * Anti-framing headers on every response (@viktorbarzin/runtime). The
 * ingress's CSP middleware replaces a Content-Security-Policy the app sets,
 * so the deployed ingress also sends `frame-ancestors 'none'` (see AGENTS.md).
 */
const frameDeny = createMiddleware().server(async ({ next }) => {
	const result = await next();
	return { ...result, response: withFrameDenial(result.response) };
});

export const startInstance = createStart(() => ({
	requestMiddleware: [observe, frameDeny, csrf],
}));
