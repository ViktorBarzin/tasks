/**
 * The error envelope (backend/tasks_api/errors.py): every non-2xx /api
 * response is `{"error": {"code", "message"}}` (@viktorbarzin/runtime).
 * tasks adds one mapping, the CalDAV errors, as the FastAPI exception
 * handlers did.
 */
import { getLogger } from "@viktorbarzin/log";
import {
	createErrorResponder,
	type ErrorMapper,
	errorResponse,
} from "@viktorbarzin/runtime";

import { CalDAVUnauthorized } from "../caldav/engine.server";

const log = getLogger("tasks.errors");

/** Nextcloud revoked or rotated the stored app password (tasks ADR-0002). */
const nextcloudUnauthorized: ErrorMapper = (err, request) => {
	if (!(err instanceof CalDAVUnauthorized)) return null;
	log.info("stored Nextcloud credential rejected", {
		path: new URL(request.url).pathname,
		error: String(err.message),
	});
	return errorResponse(
		401,
		"nextcloud_unauthorized",
		"Nextcloud rejected the stored app password; reconnect your account",
	);
};

export const toErrorResponse = createErrorResponder({
	mappers: [nextcloudUnauthorized],
	logger: log,
});
