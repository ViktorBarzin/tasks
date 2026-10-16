import { createMiddleware, createStart } from "@tanstack/react-start";

import { csrfRejection } from "#/server/auth/csrf.server";
import { withFrameDenial } from "#/server/http/headers.server";
import { extendIdleTimeout, trackRequest } from "#/server/lifecycle.server";
import { getLogger } from "#/server/logging.server";
import {
	handlerLabel,
	httpRequestDuration,
	httpRequestsTotal,
} from "#/server/metrics.server";

const accessLog = getLogger("tasks.http");

/**
 * Every request through the Start handler: Bun's idle timeout raised from
 * 10 s (a slow CalDAV answer must reach the client; /api/events lifts it
 * further), in-flight tracking for graceful shutdown, request metrics and one
 * access-log line for /api calls. Server-only: Start strips `.server()` bodies
 * and the imports only they use from the client bundle.
 */
const observe = createMiddleware().server(async ({ request, next }) => {
	extendIdleTimeout(request);
	const done = trackRequest();
	const started = performance.now();
	const { pathname } = new URL(request.url);
	const handler = handlerLabel(pathname);
	let status = 500;
	try {
		const result = await next();
		status = result.response.status;
		return result;
	} finally {
		done();
		const seconds = (performance.now() - started) / 1000;
		httpRequestsTotal.inc({
			method: request.method,
			handler,
			status: `${Math.floor(status / 100)}xx`,
		});
		httpRequestDuration.observe({ method: request.method, handler }, seconds);
		if (pathname.startsWith("/api/")) {
			accessLog.info("request", {
				method: request.method,
				path: pathname,
				status,
				duration_ms: Math.round(seconds * 1000),
			});
		}
	}
});

/**
 * The explicit CSRF check (ADR-0001, Browser security; src/server/auth/csrf.server.ts):
 * state-changing requests and the SSE stream must come from a public origin.
 * Covers server functions, server routes and /api/events alike.
 */
const csrf = createMiddleware().server(async ({ request, next }) => {
	const rejection = csrfRejection(request);
	if (rejection) return rejection;
	return next();
});
// Tell Start this is the app's CSRF middleware, so it does not warn in dev.
Object.defineProperty(csrf, Symbol.for("tanstack-start:csrf-middleware"), {
	value: true,
});

/** Anti-framing headers on every response (src/server/http/headers.server.ts). */
const frameDeny = createMiddleware().server(async ({ next }) => {
	const result = await next();
	return { ...result, response: withFrameDenial(result.response) };
});

export const startInstance = createStart(() => ({
	requestMiddleware: [observe, frameDeny, csrf],
}));
