import { createFileRoute } from "@tanstack/react-router";

import { startSignIn } from "#/server/auth/session.server";
import { toErrorResponse } from "#/server/http/errors.server";

/** Begin sign-in: redirect to Authentik (`?return=<path>`, `&login=1` for prompt=login). */
export const Route = createFileRoute("/api/auth/start")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					return await startSignIn(request);
				} catch (err) {
					return toErrorResponse(err, request);
				}
			},
		},
	},
});
