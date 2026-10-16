import { createFileRoute } from "@tanstack/react-router";
import { engineForUser } from "#/server/account/account.server";
import { getDb } from "#/server/db/client.server";
import { handleApi, readJson } from "#/server/http/api.server";
import { drizzleJournal } from "#/server/ops/journal.server";
import { applyOps } from "#/server/ops/ops.server";
import { CLIENT_ID_HEADER, opsRequestSchema } from "#/shared/contract";

/** POST /api/ops: replay a batch of client ops (src/server/ops/ops.server.ts). */
export const Route = createFileRoute("/api/ops")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleApi(request, async (user) => {
					const { ops } = await readJson(request, opsRequestSchema);
					const db = getDb();
					const engine = await engineForUser(db, user);
					try {
						return Response.json(
							await applyOps(
								{
									engine,
									journal: drizzleJournal(db),
									accountKey: user.accountKey,
									now: new Date(),
									sourceClientId: request.headers.get(CLIENT_ID_HEADER),
								},
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
