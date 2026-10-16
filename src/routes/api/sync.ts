import { createFileRoute } from "@tanstack/react-router";
import { engineForUser } from "#/server/account/account.server";
import { getDb } from "#/server/db/client.server";
import { handleApi, readQuery } from "#/server/http/api.server";
import { sync } from "#/server/sync/sync.server";
import { syncQuerySchema } from "#/shared/contract";

export const Route = createFileRoute("/api/sync")({
	server: {
		handlers: {
			GET: ({ request }) =>
				handleApi(request, async (user) => {
					const { cursor } = readQuery(request, syncQuerySchema);
					const engine = await engineForUser(getDb(), user);
					try {
						return Response.json(await sync(engine, cursor, user.accountKey));
					} finally {
						await engine.close();
					}
				}),
		},
	},
});
