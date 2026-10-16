/**
 * Plumbing for /api server routes: identity, the error envelope and body
 * validation.
 *
 *   GET: ({ request }) => handleApi(request, async (user) => Response.json(...))
 */
import type { z } from "zod";

import { type AuthUser, requireUser } from "../auth/user.server";
import { ApiError, toErrorResponse, validationMessage } from "./errors.server";

/** Resolve the caller (401 envelope when absent), run `fn`, map errors to the envelope. */
export async function handleApi(
	request: Request,
	fn: (user: AuthUser) => Promise<Response>,
): Promise<Response> {
	let user: AuthUser;
	try {
		user = await requireUser(request);
	} catch (err) {
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
