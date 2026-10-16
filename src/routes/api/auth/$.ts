import { createFileRoute } from "@tanstack/react-router";

import { handleAuthRequest } from "#/server/auth/session.server";
import { toErrorResponse } from "#/server/http/errors.server";

/** Better Auth's endpoints: sign-in, OAuth callback, sign-out, session. */
async function handle({ request }: { request: Request }): Promise<Response> {
	try {
		return await handleAuthRequest(request);
	} catch (err) {
		return toErrorResponse(err, request);
	}
}

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: { GET: handle, POST: handle },
	},
});
