import { createFileRoute } from "@tanstack/react-router";

import { handleApi } from "#/server/http/api.server";
import { getSseHub, keepRequestOpen } from "#/server/realtime/hub.server";

/**
 * Server-Sent Events for the signed-in user (contract: EVENTS_PATH in
 * src/shared/contract.ts). The CSRF origin check runs first (src/start.ts).
 */
export const Route = createFileRoute("/api/events")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleApi(request, async (user) => {
					keepRequestOpen(request);
					return getSseHub().subscribe(user.accountKey, request.signal);
				}),
		},
	},
});
