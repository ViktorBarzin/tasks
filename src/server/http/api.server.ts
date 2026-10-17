/**
 * Plumbing for /api server routes: the caller (@viktorbarzin/auth) and the
 * error envelope with the CalDAV mapping (errors.server.ts).
 *
 *   GET: ({ request }) => handleApi(request, async (user) => Response.json(...))
 */
import { appAuth, type TasksUser } from "../auth/auth.server";
import { toErrorResponse } from "./errors.server";

/** Resolve the caller (401/403 envelope when absent or pending), run `fn`, map errors to the envelope. */
export function handleApi(
	request: Request,
	fn: (user: TasksUser) => Promise<Response>,
): Promise<Response> {
	return appAuth.handleApi(request, fn, toErrorResponse);
}
