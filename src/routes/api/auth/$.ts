import { createFileRoute } from "@tanstack/react-router";

import { appAuth } from "#/server/auth/auth.server";
import { toErrorResponse } from "#/server/http/errors.server";

/** Better Auth's endpoints: OAuth callback, sign-out, session, error page. */
async function handle({ request }: { request: Request }): Promise<Response> {
	try {
		return await appAuth.handleAuthRequest(request);
	} catch (err) {
		return toErrorResponse(err, request);
	}
}

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: { GET: handle, POST: handle },
	},
});
