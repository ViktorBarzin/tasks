/**
 * Traefik→Authentik stand-in for the service-worker e2e (`playwright.sw.config.ts`).
 *
 * Two origins in one process, because the auth wall is only reproducible
 * cross-origin (a same-origin redirect is followed transparently and never
 * surfaces as `response.type === 'opaqueredirect'`):
 *
 *  - APP port  — serves `build/` plus the stubbed `/api`, exactly like the
 *    FastAPI pod behind forward-auth. While the session is expired EVERY
 *    request (navigation and `/api` alike) answers 302 to the SSO origin,
 *    which is what the real outpost does.
 *  - SSO port  — the Authentik login page stand-in: `/login` renders, and
 *    `/complete` re-authenticates the session and bounces back to `rd`.
 *
 * `/__test/expire` and `/__test/restore` on the APP port drive the session
 * state from a spec; they are the only paths exempt from the wall.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const APP_PORT = Number(args.get('app-port') ?? 4930);
const SSO_PORT = Number(args.get('sso-port') ?? 4931);
const ROOT = args.get('root') ?? 'build';
const SSO_ORIGIN = `http://127.0.0.1:${SSO_PORT}`;

/** The forward-auth session. Flipped by /__test/* and by an SSO login. */
let authenticated = true;

const LISTS = [
	{ id: 'l-a', name: 'Alpha', order: 0, sort_mode: null, deleted: false },
	{ id: 'l-b', name: 'Bravo', order: 1, sort_mode: null, deleted: false }
];

const MIME = {
	'.css': 'text/css',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};

function json(res, body, status = 200) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(payload)
	});
	res.end(payload);
}

function serveStatic(res, pathname) {
	const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
	let file = join(ROOT, rel);
	if (!existsSync(file) || statSync(file).isDirectory()) {
		// adapter-static SPA: the backend serves the shell for any app route.
		file = join(ROOT, 'index.html');
	}
	res.writeHead(200, {
		'content-type': MIME[extname(file)] ?? 'application/octet-stream',
		// The SW must be revalidated like the real deploy does, and no HTTP cache
		// may stand in for the precache we are asserting on.
		'cache-control': 'no-store'
	});
	createReadStream(file).pipe(res);
}

const app = createServer((req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${APP_PORT}`);

	if (url.pathname === '/__test/expire') {
		authenticated = false;
		return json(res, { authenticated });
	}
	if (url.pathname === '/__test/restore') {
		authenticated = true;
		return json(res, { authenticated });
	}

	if (!authenticated) {
		// The outpost bounce: an absolute cross-origin 302, carrying where to
		// return to — the shape `api.ts` detects as the auth wall.
		res.writeHead(302, {
			location: `${SSO_ORIGIN}/login?rd=${encodeURIComponent(url.href)}`,
			'set-cookie': 'authentik_proxy_e2e=pending; Path=/; HttpOnly; SameSite=Lax'
		});
		return res.end();
	}

	if (url.pathname === '/api/me') return json(res, { username: 'e2e', connected: true });
	if (url.pathname === '/api/sync')
		return json(res, { cursor: 'sw-cursor', full: true, lists: LISTS, tasks: [] });
	if (url.pathname === '/api/ops' && req.method === 'POST') {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		return req.on('end', () => {
			const ops = JSON.parse(body || '{"ops":[]}').ops ?? [];
			json(res, {
				results: ops.map((op) => ({ op_id: op.op_id, status: 'applied', error: null }))
			});
		});
	}
	if (url.pathname.startsWith('/api/')) return json(res, { error: { code: 'not_stubbed' } }, 404);

	serveStatic(res, url.pathname);
});

const sso = createServer((req, res) => {
	const url = new URL(req.url, SSO_ORIGIN);
	const rd = url.searchParams.get('rd') ?? `http://127.0.0.1:${APP_PORT}/`;

	if (url.pathname === '/complete') {
		authenticated = true;
		res.writeHead(302, { location: rd });
		return res.end();
	}
	const page = `<!doctype html><meta charset="utf-8"><title>authentik</title>
<h1 id="sso-login">SSO LOGIN</h1>
<form action="/complete" method="get">
<input type="hidden" name="rd" value="${rd.replace(/"/g, '&quot;')}">
<button type="submit">Continue</button>
</form>`;
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(page);
});

app.listen(APP_PORT, '127.0.0.1', () => console.log(`app  → http://127.0.0.1:${APP_PORT}`));
sso.listen(SSO_PORT, '127.0.0.1', () => console.log(`sso  → ${SSO_ORIGIN}`));
