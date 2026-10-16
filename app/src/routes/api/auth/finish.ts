import { createFileRoute } from "@tanstack/react-router";

import { finishSignIn } from "#/server/auth/session.server";
import { toErrorResponse } from "#/server/http/errors.server";

/** Where Better Auth lands after the OAuth callback: redirect to `?return=<path>`. */
export const Route = createFileRoute("/api/auth/finish")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					return await finishSignIn(request);
				} catch (err) {
					return toErrorResponse(err, request);
				}
			},
		},
	},
});
