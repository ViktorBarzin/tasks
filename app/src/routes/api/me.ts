import { createFileRoute } from "@tanstack/react-router";

import { getMe } from "#/server/account/account.server";
import { getDb } from "#/server/db/client.server";
import { handleApi } from "#/server/http/api.server";

export const Route = createFileRoute("/api/me")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleApi(request, async (user) =>
					Response.json(await getMe(getDb(), user)),
				),
		},
	},
});
