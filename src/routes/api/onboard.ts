import { createFileRoute } from "@tanstack/react-router";
import { noContent, readJson } from "@viktorbarzin/runtime";
import { onboard } from "#/server/account/account.server";
import { getDb } from "#/server/db/client.server";
import { handleApi } from "#/server/http/api.server";
import { accountConnected } from "#/server/product-events.server";
import { onboardRequestSchema } from "#/shared/contract";

export const Route = createFileRoute("/api/onboard")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleApi(request, async (user) => {
					const body = await readJson(request, onboardRequestSchema);
					await onboard(getDb(), user, body);
					accountConnected(user.sub);
					return noContent();
				}),
		},
	},
});
