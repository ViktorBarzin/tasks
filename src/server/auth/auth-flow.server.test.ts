/**
 * Sign-in, sessions, CSRF and API tokens over HTTP against the built server
 * (`bun run build` first), a real Postgres (TEST_DATABASE_URL) and the mock
 * Authentik in ./testing. Ports backend/tests/test_signin.py and adds the
 * identity cases ADR-0001 sets: PKCE, no offline_access, __Host- cookies, a
 * 7-day absolute session, prompt=login for the guest, the identity bridge,
 * request + approve, the 15-minute membership re-check, CSRF and bearer JWTs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

import { createSqlClient } from "../db/client.server";
import { runMigrations } from "../db/migrate.server";
import {
	type BuiltServer,
	builtServerExists,
	CookieJar,
	follow,
	MIGRATIONS_DIR,
	startBuiltServer,
	TestDatabases,
} from "./testing/built-server";
import {
	type MockAuthentik,
	startMockAuthentik,
} from "./testing/mock-authentik";

const adminUrl = process.env.TEST_DATABASE_URL;
const ready = Boolean(adminUrl) && builtServerExists();

const ALEMBIC_SCHEMA = `
CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num));
CREATE TABLE connected_accounts (
	authentik_username VARCHAR(255) NOT NULL, nc_username VARCHAR(255) NOT NULL,
	enc_app_password BYTEA NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (authentik_username));
CREATE TABLE applied_ops (
	authentik_username VARCHAR(255) NOT NULL, op_id VARCHAR(255) NOT NULL,
	kind VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL,
	applied_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (authentik_username, op_id));
INSERT INTO alembic_version (version_num) VALUES ('0002');
`;

let dbs: TestDatabases;
let sql: SQL;
let mock: MockAuthentik;
let server: BuiltServer;
let unconfigured: BuiltServer;
let dbUrl: string;

beforeAll(async () => {
	if (!ready) return;
	dbs = new TestDatabases(adminUrl as string);
	dbUrl = await dbs.create();
	sql = new SQL(dbUrl);
	await sql.unsafe(ALEMBIC_SCHEMA);
	const previous = process.env.DATABASE_URL;
	process.env.DATABASE_URL = dbUrl;
	const migrator = createSqlClient({ max: 1 });
	process.env.DATABASE_URL = previous;
	await runMigrations(migrator, MIGRATIONS_DIR);
	await migrator.close();

	mock = await startMockAuthentik();
	mock.addUser({ username: "guest", email: null, groups: ["Public Guests"] });
	server = await startBuiltServer(
		{
			DATABASE_URL: dbUrl,
			OIDC_DISCOVERY_URL: mock.discoveryUrl,
			OIDC_CLIENT_ID: mock.clientId,
			OIDC_CLIENT_SECRET: mock.clientSecret,
			API_TOKEN_AUDIENCES: `${mock.clientId},tasks-cli`,
			BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
			AUTHENTIK_API_URL: mock.apiUrl,
			AUTHENTIK_READER_TOKEN: mock.readerToken,
			AUTHENTIK_APPROVER_TOKEN: mock.approverToken,
		},
		{ origin: (port) => ({ PUBLIC_ORIGINS: `http://127.0.0.1:${port}` }) },
	);
	unconfigured = await startBuiltServer({ DATABASE_URL: dbUrl });
}, 60_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await unconfigured?.stop();
	await mock?.stop();
	await sql?.close();
	await dbs.dropAll();
});

/** Sign `username` in through the whole OAuth flow, starting at `path`. */
async function signIn(username: string, path = "/api/signin") {
	mock.session = null;
	mock.loginAs = username;
	const jar = new CookieJar();
	const result = await follow(`${server.origin}${path}`, jar, server.origin);
	return { jar, ...result };
}

function get(
	path: string,
	jar: CookieJar,
	headers: Record<string, string> = {},
) {
	return fetch(`${server.origin}${path}`, {
		redirect: "manual",
		headers: { cookie: jar.header(), ...headers },
	});
}

describe.skipIf(!ready)("the identity migration is additive", () => {
	test("Alembic's tables and version are untouched; only new tables appear", async () => {
		const columns = await sql`
			select table_name, column_name, data_type, is_nullable
			from information_schema.columns
			where table_schema = 'public'
			  and table_name in ('connected_accounts', 'applied_ops', 'alembic_version')
			order by table_name, ordinal_position`;
		expect(
			columns.map((c: Record<string, string>) => Object.values(c).join(" ")),
		).toEqual([
			"alembic_version version_num character varying NO",
			"applied_ops authentik_username character varying NO",
			"applied_ops op_id character varying NO",
			"applied_ops kind character varying NO",
			"applied_ops status character varying NO",
			"applied_ops applied_at timestamp with time zone NO",
			"connected_accounts authentik_username character varying NO",
			"connected_accounts nc_username character varying NO",
			"connected_accounts enc_app_password bytea NO",
			"connected_accounts created_at timestamp with time zone NO",
			"connected_accounts updated_at timestamp with time zone NO",
		]);
		expect(await sql`select version_num from alembic_version`).toEqual([
			{ version_num: "0002" },
		]);
		const tables = await sql`
			select table_name from information_schema.tables
			where table_schema = 'public' order by table_name`;
		expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual([
			"access_requests",
			"alembic_version",
			"applied_ops",
			"auth_account",
			"auth_session",
			"auth_user",
			"auth_verification",
			"connected_accounts",
			"identity_links",
			"member_checks",
		]);
	});
});

describe.skipIf(!ready)("sign-in (tasks ADR-0004 popup target)", () => {
	test("without sign-in configured, /api/signin is a 401 envelope", async () => {
		const res = await fetch(`${unconfigured.origin}/api/signin`, {
			redirect: "manual",
		});
		expect(res.status).toBe(401);
		expect((await res.json()).error.code).toBe("unauthorized");
	});

	test("without a session, /api/signin starts the OAuth flow with PKCE and no offline_access", async () => {
		mock.addUser({ username: "first@example.com", groups: ["Tasks Users"] });
		const { hops } = await signIn("first@example.com");
		expect(hops[0]).toMatchObject({ status: 302 });
		expect(hops[0]?.location).toBe("/api/auth/start?return=%2Fapi%2Fsignin");
		const authorize = new URL(hops[2]?.url ?? "");
		expect(authorize.origin).toBe(mock.apiUrl);
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
		expect(authorize.searchParams.get("nonce")).toBeTruthy();
		expect(authorize.searchParams.get("prompt")).toBeNull();
		expect(authorize.searchParams.get("scope")?.split(" ").sort()).toEqual([
			"email",
			"openid",
			"profile",
		]);
	});

	test("a member lands on the self-closing page with a host-only session cookie", async () => {
		mock.addUser({ username: "viktor@example.com", groups: ["Tasks Users"] });
		const { jar, response, hops } = await signIn("viktor@example.com");
		expect(hops.at(-1)?.url).toBe(`${server.origin}/api/signin`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("text/html");
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(await response.text()).toContain("window.close()");

		const session = jar.raw.find((c) =>
			c.startsWith("__Host-tasks.session_token="),
		);
		expect(session).toBeDefined();
		const attributes = (session ?? "").toLowerCase();
		expect(attributes).toContain("secure");
		expect(attributes).toContain("httponly");
		expect(attributes).toContain("path=/");
		expect(attributes).toContain("samesite=lax");
		expect(attributes).not.toContain("domain=");
		// No refresh token was issued: web sign-in never asks for offline_access.
		expect(
			mock.tokenRequests.every((t) => t.grantType === "authorization_code"),
		).toBe(true);

		const me = await get("/api/me", jar);
		expect(me.status).toBe(200);
		expect(await me.text()).toBe(
			'{"username":"viktor@example.com","connected":false}',
		);
	});

	test("sessions are capped at 7 days and never extended", async () => {
		mock.addUser({ username: "cap@example.com", groups: ["Tasks Users"] });
		const { jar } = await signIn("cap@example.com");
		const [row] = await sql`
			select extract(epoch from (s.expires_at - s.created_at))::int as seconds
			from auth_session s join auth_account a on a.user_id = s.user_id
			join member_checks m on m.sub = a.account_id where m.username = 'cap@example.com'`;
		expect(row.seconds).toBe(7 * 24 * 3600);
		await get("/api/me", jar);
		const [after] = await sql`
			select extract(epoch from (s.expires_at - s.created_at))::int as seconds
			from auth_session s join auth_account a on a.user_id = s.user_id
			join member_checks m on m.sub = a.account_id where m.username = 'cap@example.com'`;
		expect(after.seconds).toBe(7 * 24 * 3600);
	});

	test("an existing row keyed by username is found through the identity bridge", async () => {
		const user = mock.addUser({
			username: "anca@example.com",
			groups: ["Tasks Users"],
		});
		await sql`
			insert into connected_accounts (authentik_username, nc_username, enc_app_password)
			values ('anca@example.com', 'anca', ${Buffer.from("gAAAAAtoken")})`;
		const { jar } = await signIn("anca@example.com");
		const me = await (await get("/api/me", jar)).json();
		expect(me).toEqual({ username: "anca@example.com", connected: true });
		const links =
			await sql`select account_key from identity_links where sub = ${user.uid}`;
		expect(links).toEqual([{ account_key: "anca@example.com" }]);

		// A later username change at Authentik does not move the data.
		mock.users.delete("anca@example.com");
		user.username = "anca.new@example.com";
		mock.users.set(user.username, user);
		const again = await signIn("anca.new@example.com");
		const me2 = await (await get("/api/me", again.jar)).json();
		expect(me2).toEqual({ username: "anca.new@example.com", connected: true });
	});

	test("a reused username does not inherit another subject's data", async () => {
		await sql`
			insert into identity_links (sub, account_key, linked_username)
			values ('someone-else', 'reused@example.com', 'reused@example.com')`;
		const user = mock.addUser({
			username: "reused@example.com",
			groups: ["Tasks Users"],
		});
		const { jar } = await signIn("reused@example.com");
		expect((await get("/api/me", jar)).status).toBe(200);
		const [link] =
			await sql`select account_key from identity_links where sub = ${user.uid}`;
		expect(link.account_key).toBe(`sub:${user.uid}`);
	});

	test("the anonymous guest is sent back with prompt=login", async () => {
		mock.addUser({ username: "real@example.com", groups: ["Tasks Users"] });
		mock.session = "guest";
		mock.loginAs = "real@example.com";
		mock.authorizations.length = 0;
		const jar = new CookieJar();
		const { hops, response } = await follow(
			`${server.origin}/api/auth/start?return=%2F`,
			jar,
			server.origin,
		);
		expect(mock.authorizations.map((a) => [a.prompt, a.user])).toEqual([
			[null, "guest"],
			["login", "real@example.com"],
		]);
		expect(
			hops.some((h) => h.url.includes("/api/auth/start?return=%2F&login=1")),
		).toBe(true);
		expect(hops.at(-1)?.url).toBe(`${server.origin}/`);
		expect(response.status).toBe(200);
		expect((await get("/api/me", jar)).status).toBe(200);
		const guests =
			await sql`select count(*)::int as n from auth_user where name = 'guest'`;
		expect(guests[0].n).toBe(0);
	});

	test("a guest again after prompt=login stops on the error page, not a loop", async () => {
		mock.session = "guest";
		mock.loginAs = "guest";
		const jar = new CookieJar();
		const { hops } = await follow(
			`${server.origin}/api/auth/start?return=%2F`,
			jar,
			server.origin,
		);
		expect(hops.at(-1)?.url).toBe(
			`${server.origin}/api/auth/error?error=guest_session`,
		);
		expect(jar.cookies.has("__Host-tasks.session_token")).toBe(false);
	});

	test("full-page sign-in keeps return_to and comes back to the screen it left", async () => {
		mock.addUser({ username: "back@example.com", groups: ["Tasks Users"] });
		const { hops, response } = await signIn(
			"back@example.com",
			"/api/signin?return_to=%2Flist%2Fwork%3Fx%3D1",
		);
		expect(hops[0]?.location).toBe(
			"/api/auth/start?return=%2Fapi%2Fsignin%3Freturn_to%3D%252Flist%252Fwork%253Fx%253D1",
		);
		expect(hops.at(-1)?.url).toBe(`${server.origin}/list/work?x=1`);
		expect(response.status).toBe(200);
	});

	test("with a session, /api/signin?return_to= redirects there, same-origin paths only", async () => {
		mock.addUser({ username: "there@example.com", groups: ["Tasks Users"] });
		const { jar } = await signIn("there@example.com");
		const back = await get("/api/signin?return_to=%2Fview%2Ftoday", jar);
		expect(back.status).toBe(302);
		expect(back.headers.get("location")).toBe("/view/today");
		for (const evil of [
			"https://evil.example/",
			"//evil.example/",
			"/\\evil",
			"/.//evil.example/x",
			"/..//evil.example",
			"/%2e//evil.example",
		]) {
			const res = await get(
				`/api/signin?return_to=${encodeURIComponent(evil)}`,
				jar,
			);
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/");
		}
	});

	test("an absolute return URL is not followed (no open redirect)", async () => {
		mock.addUser({ username: "redir@example.com", groups: ["Tasks Users"] });
		mock.session = null;
		mock.loginAs = "redir@example.com";
		const jar = new CookieJar();
		const { hops } = await follow(
			`${server.origin}/api/auth/start?return=https%3A%2F%2Fevil.example%2F`,
			jar,
			server.origin,
		);
		expect(hops.at(-1)?.url).toBe(`${server.origin}/`);
	});

	test("/api/auth/finish never redirects off-origin through dot segments", async () => {
		for (const evil of [
			"/.//evil.example/x",
			"/..//evil.example",
			"/./\\evil",
		]) {
			const res = await fetch(
				`${server.origin}/api/auth/finish?return=${encodeURIComponent(evil)}`,
				{ redirect: "manual" },
			);
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/");
		}
	});

	test("pages, /api and redirects refuse to be framed", async () => {
		const jar = new CookieJar();
		for (const path of [
			"/",
			"/view/today",
			"/api/me",
			"/api/auth/finish?return=/",
		]) {
			const res = await get(path, jar);
			expect(res.headers.get("content-security-policy")).toBe(
				"frame-ancestors 'none'",
			);
			expect(res.headers.get("x-frame-options")).toBe("DENY");
		}
	});

	test("sign-out ends the session", async () => {
		mock.addUser({ username: "bye@example.com", groups: ["Tasks Users"] });
		const { jar } = await signIn("bye@example.com");
		const out = await fetch(`${server.origin}/api/auth/sign-out`, {
			method: "POST",
			headers: {
				cookie: jar.header(),
				origin: server.origin,
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(out.status).toBe(200);
		jar.store(out);
		expect((await get("/api/me", jar)).status).toBe(401);
	});

	test("Better Auth endpoints the app does not use are refused", async () => {
		const res = await fetch(`${server.origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { origin: server.origin, "content-type": "application/json" },
			body: JSON.stringify({ provider: "authentik" }),
		});
		expect(res.status).toBe(404);
	});
});

describe.skipIf(!ready)(
	"membership (request + approve, 15-minute re-check)",
	() => {
		test("a signed-in non-member gets 403 access_pending and an access request", async () => {
			const user = mock.addUser({
				username: "stranger@example.com",
				groups: [],
			});
			const { jar, response } = await signIn("stranger@example.com");
			expect(response.status).toBe(200); // the popup still closes
			const me = await get("/api/me", jar);
			expect(me.status).toBe(403);
			expect((await me.json()).error.code).toBe("access_pending");
			const [request] =
				await sql`select status, username from access_requests where sub = ${user.uid}`;
			expect(request).toEqual({
				status: "pending",
				username: "stranger@example.com",
			});
		});

		test("removal at Authentik takes effect at the next re-check", async () => {
			const user = mock.addUser({
				username: "leaver@example.com",
				groups: ["Tasks Users"],
			});
			const { jar } = await signIn("leaver@example.com");
			expect((await get("/api/me", jar)).status).toBe(200);
			user.groups = [];
			// Still within 15 minutes: the stored answer stands.
			expect((await get("/api/me", jar)).status).toBe(200);
			await sql`update member_checks set checked_at = now() - interval '16 minutes' where sub = ${user.uid}`;
			mock.apiCalls.length = 0;
			const me = await get("/api/me", jar);
			expect(me.status).toBe(403);
			expect(mock.apiCalls).toEqual([
				{
					method: "GET",
					path: "/core/users/",
					token: mock.readerToken,
				},
			]);
		});

		test("when Authentik cannot answer, the last answer stands", async () => {
			const user = mock.addUser({
				username: "steady@example.com",
				groups: ["Tasks Users"],
			});
			const { jar } = await signIn("steady@example.com");
			await sql`update member_checks set checked_at = now() - interval '16 minutes' where sub = ${user.uid}`;
			mock.apiFailure = 503;
			try {
				expect((await get("/api/me", jar)).status).toBe(200);
			} finally {
				mock.apiFailure = null;
			}
		});
	},
);

describe.skipIf(!ready)("CSRF origin check", () => {
	let jar: CookieJar;
	beforeAll(async () => {
		mock.addUser({ username: "csrf@example.com", groups: ["Tasks Users"] });
		jar = (await signIn("csrf@example.com")).jar;
	});

	const post = (path: string, headers: Record<string, string>) =>
		fetch(`${server.origin}${path}`, {
			method: "POST",
			headers: {
				cookie: jar.header(),
				"content-type": "application/json",
				...headers,
			},
			body: JSON.stringify({ ops: [] }),
		});

	test("a cookie POST from a sibling subdomain is refused", async () => {
		const res = await post("/api/ops", {
			origin: "https://pages.viktorbarzin.me",
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe("forbidden");
	});

	test("Sec-Fetch-Site other than same-origin is refused", async () => {
		const res = await post("/api/ops", { "sec-fetch-site": "same-site" });
		expect(res.status).toBe(403);
	});

	test("a cookie POST with neither header is refused", async () => {
		expect((await post("/api/ops", {})).status).toBe(403);
	});

	test("the public origin passes the check", async () => {
		const res = await post("/api/ops", { origin: server.origin });
		expect(res.status).not.toBe(403);
	});

	test("server functions are covered", async () => {
		const res = await fetch(`${server.origin}/_serverFn/anything`, {
			method: "POST",
			headers: { cookie: jar.header(), origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
	});

	test("the SSE endpoint is covered", async () => {
		const res = await get("/api/events", jar, {
			"sec-fetch-site": "cross-site",
		});
		expect(res.status).toBe(403);
	});
});

describe.skipIf(!ready)("API bearer tokens", () => {
	const bearer = (token: string, extra: Record<string, string> = {}) =>
		fetch(`${server.origin}/api/me`, {
			headers: { authorization: `Bearer ${token}`, ...extra },
		});

	test("a valid Authentik JWT is accepted, for any of the app's client IDs", async () => {
		const user = mock.addUser({
			username: "cli@example.com",
			groups: ["Tasks Users"],
		});
		const claims = {
			sub: user.uid,
			preferred_username: user.username,
			groups: user.groups,
		};
		const web = await bearer(await mock.mintAccessToken(claims));
		expect(web.status).toBe(200);
		expect((await web.json()).username).toBe("cli@example.com");
		const cli = await bearer(
			await mock.mintAccessToken(claims, { audience: "tasks-cli" }),
		);
		expect(cli.status).toBe(200);
	});

	test("a service account in Tasks Agents is a member", async () => {
		const agent = mock.addUser({
			username: "ha-agent",
			groups: ["Tasks Agents"],
		});
		const res = await bearer(
			await mock.mintAccessToken({
				sub: agent.uid,
				preferred_username: agent.username,
				groups: agent.groups,
			}),
		);
		expect(res.status).toBe(200);
	});

	test.each([
		["another app's audience", { audience: "grafana" }],
		["an expired token", { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
		["HS256 instead of RS256", { alg: "HS256" }],
	] as const)("refuses %s", async (_name, options) => {
		const user = mock.addUser({
			username: `bad-${crypto.randomUUID()}`,
			groups: ["Tasks Users"],
		});
		const token = await mock.mintAccessToken(
			{ sub: user.uid, preferred_username: user.username, groups: user.groups },
			options,
		);
		const res = await bearer(token);
		expect(res.status).toBe(401);
		expect((await res.json()).error.code).toBe("unauthorized");
	});

	test("a token from another issuer is refused", async () => {
		const other = await startMockAuthentik();
		try {
			const token = await other.mintAccessToken({
				sub: "x",
				preferred_username: "x",
			});
			expect((await bearer(token)).status).toBe(401);
		} finally {
			await other.stop();
		}
	});

	test("a bad bearer token does not fall back to the session cookie", async () => {
		mock.addUser({ username: "both@example.com", groups: ["Tasks Users"] });
		const { jar } = await signIn("both@example.com");
		const res = await bearer("not-a-jwt", { cookie: jar.header() });
		expect(res.status).toBe(401);
	});
});

describe.skipIf(!ready)("Better Auth's rate limiter in production", () => {
	let prod: BuiltServer;

	beforeAll(async () => {
		prod = await startBuiltServer(
			{
				NODE_ENV: "production",
				DATABASE_URL: dbUrl,
				OIDC_DISCOVERY_URL: mock.discoveryUrl,
				OIDC_CLIENT_ID: mock.clientId,
				OIDC_CLIENT_SECRET: mock.clientSecret,
				BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
				AUTHENTIK_API_URL: mock.apiUrl,
				AUTHENTIK_READER_TOKEN: mock.readerToken,
				AUTHENTIK_APPROVER_TOKEN: mock.approverToken,
			},
			{ origin: (port) => ({ PUBLIC_ORIGINS: `http://127.0.0.1:${port}` }) },
		);
	}, 30_000);

	afterAll(async () => {
		await prod?.stop();
	});

	const callback = (realIp: string, forwardedFor: string) =>
		fetch(`${prod.origin}/api/auth/callback/authentik?code=x&state=y`, {
			redirect: "manual",
			headers: { "x-real-ip": realIp, "x-forwarded-for": forwardedFor },
		});

	test("one client filling its bucket does not lock out another", async () => {
		const noisy: number[] = [];
		for (let i = 0; i < 110; i++)
			noisy.push((await callback("1.2.3.4", "1.2.3.4, 10.10.0.5")).status);
		// The limiter is on: the noisy client hits its own limit.
		expect(noisy).toContain(429);
		const other = await callback("5.6.7.8", "5.6.7.8, 10.10.0.6");
		expect(other.status).not.toBe(429);
	}, 30_000);
});
