import { createMiddleware, createStart } from "@tanstack/react-start";
import { getLogger, withLogContext } from "@viktorbarzin/log";
import { createHandlerLabeler, observeRequest } from "@viktorbarzin/metrics";
import { withFrameDenial } from "@viktorbarzin/runtime";
import { visitorHeaders } from "@viktorbarzin/telemetry/browser";
import { withRequestContext } from "@viktorbarzin/telemetry/server";

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
 * access-log line for /api calls. The request runs in its own log context, so
 * `enduser.id` set once the caller is known (src/server/http/api.server.ts)
 * is on every later line of the request, the access-log line included.
 * Server-only: Start strips `.server()` bodies and the imports only they use
 * from the client bundle.
 */
const observe = createMiddleware().server(({ request, next }) =>
	withLogContext({}, async () => {
		const done = observeRequest(request, { label, accessLog });
		let status = 500;
		try {
			const result = await next();
			status = result.response.status;
			return result;
		} finally {
			done(status);
		}
	}),
);

/**
 * Product events sent while handling a request carry the browser's Rybbit
 * visitor id (`X-Visitor-Id`), IP and User-Agent (tasks ADR-0005), so they
 * land on the same Rybbit user as its pageviews.
 */
const sender = createMiddleware().server(({ request, next }) =>
	withRequestContext(request, next),
);

/** Server function calls from the browser send the Rybbit visitor id. */
const visitor = createMiddleware({ type: "function" }).client(({ next }) =>
	next({ headers: visitorHeaders() }),
);

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
	requestMiddleware: [observe, sender, frameDeny, csrf],
	functionMiddleware: [visitor],
}));
