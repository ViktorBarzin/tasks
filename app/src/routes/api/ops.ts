import { createFileRoute } from "@tanstack/react-router";
import { engineForUser } from "#/server/account/account.server";
import { getDb } from "#/server/db/client.server";
import { handleApi, readJson } from "#/server/http/api.server";
import { applyOps } from "#/server/ops/ops.server";
import { opsRequestSchema } from "#/shared/contract";

export const Route = createFileRoute("/api/ops")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleApi(request, async (user) => {
					const { ops } = await readJson(request, opsRequestSchema);
					const db = getDb();
					const engine = await engineForUser(db, user);
					try {
						const now = new Date();
						return Response.json(
							await applyOps(
								{ db, engine, accountKey: user.accountKey, now },
								ops,
							),
						);
					} finally {
						await engine.close();
					}
				}),
		},
	},
});
