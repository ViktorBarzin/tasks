import { createFileRoute } from "@tanstack/react-router";

import { handleApi } from "#/server/http/api.server";

/**
 * The landing page of the sign-in popup (tasks ADR-0004). Reaching it proves
 * a session, so it only closes itself; the opener's /api/me poll is the
 * backstop for browsers that refuse a scripted close. Never cached, so a
 * walled popup cannot fake it. Same bytes as backend/tasks_api/routers/signin.py.
 */
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
			GET: ({ request }) =>
				handleApi(
					request,
					async () =>
						new Response(PAGE, {
							headers: {
								"content-type": "text/html; charset=utf-8",
								"cache-control": "no-store",
							},
						}),
				),
		},
	},
});
