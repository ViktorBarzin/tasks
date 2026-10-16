import { createFileRoute } from "@tanstack/react-router";

import { handleApi } from "#/server/http/api.server";
import { ApiError } from "#/server/http/errors.server";

/** Unknown /api paths: 401 without an identity, else a 404 envelope (as FastAPI answered). */
async function notFound({ request }: { request: Request }): Promise<Response> {
	return handleApi(request, async () => {
		throw new ApiError(404, "not_found", "Not Found");
	});
}

export const Route = createFileRoute("/api/$")({
	server: {
		handlers: {
			GET: notFound,
			POST: notFound,
			PUT: notFound,
			DELETE: notFound,
		},
	},
});
