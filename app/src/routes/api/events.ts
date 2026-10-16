import { createFileRoute } from "@tanstack/react-router";

import { handleApi } from "#/server/http/api.server";
import { getSseHub } from "#/server/realtime/hub.server";

/** Server-Sent Events for the signed-in user (contract: EVENTS_PATH in src/shared/contract.ts). */
export const Route = createFileRoute("/api/events")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleApi(request, async (user) =>
					getSseHub().subscribe(user.accountKey, request.signal),
				),
		},
	},
});
