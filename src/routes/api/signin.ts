import { createFileRoute } from "@tanstack/react-router";

import { safeReturnPath } from "@viktorbarzin/auth";
import { ApiError } from "@viktorbarzin/runtime";

import { appAuth } from "#/server/auth/auth.server";
import { toErrorResponse } from "#/server/http/errors.server";
import { SIGNIN_PATH } from "#/shared/contract";

/**
 * The landing page of the sign-in popup (tasks ADR-0004). With a session it
 * only closes itself; the opener's /api/me poll is the backstop for browsers
 * that refuse a scripted close. Without one it starts the OAuth flow, which
 * comes back here (forward-auth used to do that bounce). A signed-in person
 * who is still waiting for approval also gets the page: the opener's
 * /api/me then answers 403 `access_pending`. Never cached, so a walled popup
 * cannot fake it. Same bytes as backend/tasks_api/routers/signin.py.
 *
 * The full-page path (src/client/relogin.ts, tasks ADR-0003) opens
 * `/api/signin?return_to=<path>`: the OAuth flow comes back here with
 * `return_to` intact, and a signed-in request is redirected to that path
 * (same-origin paths only, safeReturnPath) instead of getting the page.
 */
const RETURN_TO_PARAM = "return_to";
const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
         justify-content: center; background: #111; color: #f5f5f7;
         font: 17px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  p { margin: 0; padding: 24px; text-align: center; }
</style>
<p>Signed in — you can close this window.</p>
<script>
  // Scripted close is allowed for a script-opened window. Where it is not
  // (an in-app browser), the opener notices the live session and takes over.
  window.close();
</script>
`;

export const Route = createFileRoute("/api/signin")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const returnTo = new URL(request.url).searchParams.get(
						RETURN_TO_PARAM,
					);
					if (await appAuth.resolveUser(request)) {
						if (returnTo !== null) {
							return new Response(null, {
								status: 302,
								headers: {
									location: safeReturnPath(returnTo),
									"cache-control": "no-store",
								},
							});
						}
						return new Response(PAGE, {
							headers: {
								"content-type": "text/html; charset=utf-8",
								"cache-control": "no-store",
							},
						});
					}
					const start = appAuth.signInRedirect(
						returnTo === null
							? SIGNIN_PATH
							: `${SIGNIN_PATH}?${new URLSearchParams({ [RETURN_TO_PARAM]: safeReturnPath(returnTo) })}`,
					);
					if (start) return start;
					throw new ApiError(401, "unauthorized", "not signed in");
				} catch (err) {
					return toErrorResponse(err, request);
				}
			},
		},
	},
});
