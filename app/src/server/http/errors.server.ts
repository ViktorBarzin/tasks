/**
 * The error envelope (backend/tasks_api/errors.py): every non-2xx /api
 * response is `{"error": {"code", "message"}}`. `toErrorResponse` maps the
 * app's own errors and the CalDAV errors onto it, as the FastAPI exception
 * handlers did.
 */
import type { ErrorEnvelope } from "#/shared/contract";
import { CalDAVUnauthorized } from "../caldav/engine.server";
import { getLogger } from "../logging.server";
import { NotImplementedError } from "../not-implemented.server";

const log = getLogger("tasks.errors");

/** An expected API failure with a stable machine-readable code. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function errorResponse(
	status: number,
	code: string,
	message: string,
	headers?: HeadersInit,
): Response {
	const body: ErrorEnvelope = { error: { code, message } };
	return Response.json(body, { status, headers });
}

/**
 * Validation failures name the field and the problem, never the input:
 * on /api/onboard the input is the plaintext app password (contract v1.1 §G).
 */
export function validationMessage(
	issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
	const parts = issues.map((issue) => {
		const loc = issue.path.map(String).join(".");
		return loc ? `${loc}: ${issue.message}` : issue.message;
	});
	return parts.join("; ") || "validation error";
}

export function toErrorResponse(err: unknown, request: Request): Response {
	if (err instanceof ApiError) {
		return errorResponse(err.status, err.code, err.message);
	}
	const path = new URL(request.url).pathname;
	if (err instanceof CalDAVUnauthorized) {
		// Nextcloud revoked or rotated the stored app password (tasks ADR-0002).
		log.info("stored Nextcloud credential rejected", {
			path,
			error: String(err.message),
		});
		return errorResponse(
			401,
			"nextcloud_unauthorized",
			"Nextcloud rejected the stored app password; reconnect your account",
		);
	}
	if (err instanceof NotImplementedError) {
		// A contract stub a builder has not filled in yet.
		return errorResponse(501, "not_implemented", err.message);
	}
	log.exception("unhandled error", err, { path, method: request.method });
	return errorResponse(500, "internal_error", "internal server error");
}
