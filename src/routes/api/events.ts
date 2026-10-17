import { createFileRoute } from "@tanstack/react-router";

import { handleApi } from "#/server/http/api.server";
import { realtime } from "#/server/realtime/realtime.server";

/**
 * Server-Sent Events for the signed-in user (contract: EVENTS_PATH in
 * src/shared/contract.ts), keyed by the account key the pokes are sent to.
 * The CSRF origin check runs first (src/start.ts).
 */
export const Route = createFileRoute("/api/events")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleApi(request, async (user) =>
					realtime.subscribe(request, user.accountKey),
				),
		},
	},
});
