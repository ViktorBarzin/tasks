/**
 * A stand-in for the deployed origin, for the service-worker specs (e2e/sw/).
 * Started per test inside the Playwright worker, on its own two ports, so
 * each test gets a fresh origin and its own state.
 *
 *  - APP origin: the page and the stubbed /api. Pages and assets come from
 *    the BUILT TypeScript server (`upstream`, proxied) in "react" mode, or
 *    from the Svelte build directory in "svelte" mode, which is how the
 *    cutover spec swaps the image under an installed PWA. /api is always the
 *    stub below, shaped like the TypeScript server: no session → 401
 *    `unauthorized` envelope; GET /api/signin starts an OIDC round trip.
 *  - SSO origin: an Authentik stand-in. /authorize shows a login page
 *    (#sso-login, "Continue"), /complete redirects back to the app's OAuth
 *    callback, which sets the session cookie and returns to /api/signin.
 *
 * `page.route` cannot stub requests made by a service worker, so the PWA
 * specs stub at this server instead.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

export interface StubList {
	id: string;
	name: string;
	order: number | null;
	sort_mode: string | null;
	deleted: boolean;
}

export interface WireOp {
	op_id: string;
	kind: string;
	[key: string]: unknown;
}

export interface PostedBatch {
	ops: WireOp[];
	clientId: string | null;
}

export interface PwaServer {
	appUrl: string;
	ssoUrl: string;
	/** "react": the TypeScript build; "svelte": the old static build. */
	mode: "react" | "svelte";
	authenticated: boolean;
	/** When true, POST /api/ops without an X-Tasks-Client-Id header gets a 503. */
	opsNeedClientId: boolean;
	lists: StubList[];
	batches: PostedBatch[];
	syncCount: number;
	/** Push an SSE event to every open /api/events stream. */
	push(event: string, data: unknown): void;
	openStreams(): number;
	/** End every open /api/events stream (a pod restart, a dropped tunnel). */
	dropStreams(): void;
	close(): Promise<void>;
}

const MIME: Record<string, string> = {
	".css": "text/css",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webmanifest": "application/manifest+json",
};

// The real cookie is `__Host-` prefixed; that needs HTTPS, so the stand-in uses a plain name.
const SESSION_COOKIE = "tasks_e2e_session";

function json(res: ServerResponse, body: unknown, status = 200): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function redirect(
	res: ServerResponse,
	location: string,
	cookie?: string,
): void {
	res.writeHead(302, {
		location,
		"cache-control": "no-store",
		...(cookie ? { "set-cookie": cookie } : {}),
	});
	res.end();
}

function html(res: ServerResponse, body: string): void {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) body += chunk;
	return body;
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve((server.address() as AddressInfo).port),
		);
	});
}

/** A same-origin path, or "/" (the real endpoint must refuse open redirects too). */
function safeReturnTo(value: string | null): string {
	return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function startPwaServer(options: {
	upstream: string;
	svelteBuild?: string;
	lists?: StubList[];
	tasks?: unknown[];
}): Promise<PwaServer> {
	const streams = new Set<ServerResponse>();
	const app = createServer();
	const sso = createServer();
	const appPort = await listen(app);
	const ssoPort = await listen(sso);
	const appUrl = `http://127.0.0.1:${appPort}`;
	const ssoUrl = `http://127.0.0.1:${ssoPort}`;

	const state: PwaServer = {
		appUrl,
		ssoUrl,
		mode: "react",
		authenticated: true,
		opsNeedClientId: false,
		lists: options.lists ?? [
			{ id: "l-a", name: "Alpha", order: 0, sort_mode: null, deleted: false },
			{ id: "l-b", name: "Bravo", order: 1, sort_mode: null, deleted: false },
		],
		batches: [],
		syncCount: 0,
		push(event, data) {
			for (const res of streams)
				res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		},
		openStreams: () => streams.size,
		dropStreams() {
			for (const res of streams) res.end();
			streams.clear();
		},
		close: async () => {
			for (const res of streams) res.end();
			await Promise.all([
				new Promise((r) => app.close(r)),
				new Promise((r) => sso.close(r)),
			]);
			app.closeAllConnections();
			sso.closeAllConnections();
		},
	};

	/**
	 * The session is one server-side flag (tests flip it to expire it), not
	 * the cookie: the browser keeps sending a cookie the server has revoked.
	 */
	function hasSession(_req: IncomingMessage): boolean {
		return state.authenticated;
	}

	async function handleApi(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	): Promise<void> {
		const path = url.pathname;

		if (path === "/api/signin") {
			if (!hasSession(req)) {
				// Better Auth's generic OAuth sign-in: off to the provider, with the
				// way back in `state`.
				const authorize = new URL("/authorize", ssoUrl);
				authorize.searchParams.set(
					"redirect_uri",
					`${appUrl}/api/auth/oauth2/callback/authentik`,
				);
				authorize.searchParams.set("state", url.pathname + url.search);
				return redirect(res, authorize.href);
			}
			const returnTo = url.searchParams.get("return_to");
			if (returnTo !== null) return redirect(res, safeReturnTo(returnTo));
			return html(
				res,
				'<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
					'<p id="signed-in">Signed in — you can close this window.</p>' +
					"<script>window.close()</script>",
			);
		}

		if (path === "/api/auth/oauth2/callback/authentik") {
			state.authenticated = true;
			return redirect(
				res,
				safeReturnTo(url.searchParams.get("state")),
				`${SESSION_COOKIE}=ok; Path=/; HttpOnly; SameSite=Lax`,
			);
		}

		if (!hasSession(req))
			return json(
				res,
				{ error: { code: "unauthorized", message: "sign in required" } },
				401,
			);

		if (path === "/api/me")
			return json(res, { username: "e2e", connected: true });

		if (path === "/api/sync") {
			state.syncCount++;
			return json(res, {
				cursor: `cursor-${state.syncCount}`,
				full: true,
				lists: state.lists,
				tasks: options.tasks ?? [],
			});
		}

		if (path === "/api/ops" && req.method === "POST") {
			const clientId = (req.headers["x-tasks-client-id"] as string) ?? null;
			const body = await readBody(req);
			if (state.opsNeedClientId && !clientId)
				return json(
					res,
					{ error: { code: "internal_error", message: "held" } },
					503,
				);
			const { ops } = JSON.parse(body || '{"ops":[]}') as { ops: WireOp[] };
			state.batches.push({ ops, clientId });
			return json(res, {
				results: ops.map((op) => ({
					op_id: op.op_id,
					status: "applied",
					error: null,
				})),
			});
		}

		if (path === "/api/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write("retry: 500\n\n");
			streams.add(res);
			req.on("close", () => streams.delete(res));
			return;
		}

		return json(res, { error: { code: "not_found", message: path } }, 404);
	}

	function serveSvelte(res: ServerResponse, pathname: string): void {
		const root = options.svelteBuild;
		if (!root) {
			res.writeHead(500);
			res.end("no svelte build configured");
			return;
		}
		const rel = normalize(decodeURIComponent(pathname)).replace(
			/^(\.\.[/\\])+/,
			"",
		);
		let file = join(root, rel);
		if (!existsSync(file) || statSync(file).isDirectory())
			file = join(root, "index.html");
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"cache-control": "no-store",
		});
		createReadStream(file).pipe(res);
	}

	function proxy(req: IncomingMessage, res: ServerResponse): void {
		const target = new URL(req.url ?? "/", options.upstream);
		const upstream = httpRequest(
			target,
			{ method: req.method, headers: { ...req.headers, host: target.host } },
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		upstream.on("error", () => {
			res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	}

	app.on("request", (req, res) => {
		const url = new URL(req.url ?? "/", appUrl);
		if (url.pathname.startsWith("/api/")) {
			void handleApi(req, res, url).catch(() => {
				res.writeHead(500);
				res.end();
			});
			return;
		}
		if (state.mode === "svelte") serveSvelte(res, url.pathname);
		else proxy(req, res);
	});

	sso.on("request", (req, res) => {
		const url = new URL(req.url ?? "/", ssoUrl);
		const redirectUri = url.searchParams.get("redirect_uri") ?? `${appUrl}/`;
		const back = url.searchParams.get("state") ?? "/";
		if (url.pathname === "/complete") {
			const callback = new URL(redirectUri);
			callback.searchParams.set("code", "e2e-code");
			callback.searchParams.set("state", back);
			return redirect(res, callback.href);
		}
		const attr = (v: string) =>
			v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
		return html(
			res,
			`<!doctype html><meta charset="utf-8"><title>authentik</title>
<h1 id="sso-login">SSO LOGIN</h1>
<form action="/complete" method="get">
<input type="hidden" name="redirect_uri" value="${attr(redirectUri)}">
<input type="hidden" name="state" value="${attr(back)}">
<button type="submit">Continue</button>
</form>`,
		);
	});

	return state;
}
