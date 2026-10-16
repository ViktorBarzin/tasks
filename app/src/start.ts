import { createMiddleware, createStart } from "@tanstack/react-start";

import { getLogger } from "#/server/logging.server";
import {
	handlerLabel,
	httpRequestDuration,
	httpRequestsTotal,
} from "#/server/metrics.server";

const accessLog = getLogger("tasks.http");

/**
 * Every request through the Start handler: request metrics and one access-log
 * line for /api calls. Server-only: Start strips `.server()` bodies and the
 * imports only they use from the client bundle.
 */
const observe = createMiddleware().server(async ({ request, next }) => {
	const started = performance.now();
	const { pathname } = new URL(request.url);
	const handler = handlerLabel(pathname);
	let status = 500;
	try {
		const result = await next();
		status = result.response.status;
		return result;
	} finally {
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

export const startInstance = createStart(() => ({
	requestMiddleware: [observe],
}));
