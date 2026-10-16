import { createFileRoute } from "@tanstack/react-router";
import { onboard } from "#/server/account/account.server";
import { getDb } from "#/server/db/client.server";
import { handleApi, noContent, readJson } from "#/server/http/api.server";
import { onboardRequestSchema } from "#/shared/contract";

export const Route = createFileRoute("/api/onboard")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleApi(request, async (user) => {
					const body = await readJson(request, onboardRequestSchema);
					await onboard(getDb(), user, body);
					return noContent();
				}),
		},
	},
});
