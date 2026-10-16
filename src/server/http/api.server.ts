/**
 * Plumbing for /api server routes: identity, the error envelope and body
 * validation, as the FastAPI middleware and exception handlers provided.
 *
 *   GET: ({ request }) => handleApi(request, async (user) => Response.json(...))
 */
import type { z } from "zod";

import { CLIENT_ID_HEADER } from "#/shared/contract";
import { type AuthUser, requireUser } from "../auth/user.server";
import { ApiError, toErrorResponse, validationMessage } from "./errors.server";

/** The /api routes the Svelte build (before the cutover) called. */
const LEGACY_PATHS = new Set([
	"/api/me",
	"/api/onboard",
	"/api/sync",
	"/api/ops",
]);

/**
 * During the cutover the Svelte page still open in a browser talks to this
 * server. It reads an expired session only from a redirect (forward-auth's
 * bounce, seen as an `opaqueredirect`) and reads any 401 as "Nextcloud
 * rejected the app password", which invites the person to reconnect for no
 * reason. So a same-origin browser request without a session that does not
 * carry the React build's X-Tasks-Client-Id gets a 302 to /api/signin instead
 * of the 401 envelope. CLIs and agents (no Sec-Fetch-Site, or a bearer token)
 * and the React build keep the 401.
 */
export function legacyClientRedirect(request: Request): Response | null {
	if (!LEGACY_PATHS.has(new URL(request.url).pathname)) return null;
	if (request.headers.has(CLIENT_ID_HEADER)) return null;
	if (request.headers.has("authorization")) return null;
	if (request.headers.get("sec-fetch-site") !== "same-origin") return null;
	if (request.headers.get("sec-fetch-mode") === "navigate") return null;
	return new Response(null, {
		status: 302,
		headers: { location: "/api/signin", "cache-control": "no-store" },
	});
}

function isNoSession(err: unknown): boolean {
	return (
		err instanceof ApiError && err.status === 401 && err.code === "unauthorized"
	);
}

/** Resolve the caller (401 envelope when absent), run `fn`, map errors to the envelope. */
export async function handleApi(
	request: Request,
	fn: (user: AuthUser) => Promise<Response>,
): Promise<Response> {
	let user: AuthUser;
	try {
		user = await requireUser(request);
	} catch (err) {
		if (isNoSession(err)) {
			const redirect = legacyClientRedirect(request);
			if (redirect) return redirect;
		}
		return toErrorResponse(err, request);
	}
	try {
		return await fn(user);
	} catch (err) {
		return toErrorResponse(err, request);
	}
}

/** Parse and validate a JSON body; failures are a 422 `validation_error` that never echoes the input. */
export async function readJson<S extends z.ZodType>(
	request: Request,
	schema: S,
): Promise<z.infer<S>> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		throw new ApiError(422, "validation_error", "body: invalid JSON");
	}
	return validated(schema, raw, "body");
}

/** Validate query parameters (first value of each key). */
export function readQuery<S extends z.ZodType>(
	request: Request,
	schema: S,
): z.infer<S> {
	const params = Object.fromEntries(new URL(request.url).searchParams);
	return validated(schema, params, "query");
}

function validated<S extends z.ZodType>(
	schema: S,
	raw: unknown,
	where: string,
): z.infer<S> {
	const result = schema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.map((issue) => ({
			path: [where, ...issue.path],
			message: issue.message,
		}));
		throw new ApiError(422, "validation_error", validationMessage(issues));
	}
	return result.data;
}

export function noContent(): Response {
	return new Response(null, { status: 204 });
}
