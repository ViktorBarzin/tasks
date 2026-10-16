/**
 * The /api server routes end to end, in-process: route handler, identity,
 * the error envelope, Postgres (connected_accounts, applied_ops) and the
 * engine-level fake Nextcloud. Port of the route-level halves of
 * backend/tests/test_onboarding.py, test_errors.py and test_ops.py.
 *
 * Runs when TEST_DATABASE_URL is set. The fake Nextcloud here holds Lists but
 * no tasks: VTODO parsing belongs to the ICS mapper, whose real
 * implementation arrives with the CalDAV branch; ops and sync semantics with
 * tasks are covered in src/server/ops and src/server/sync.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { randomBytes } from "node:crypto";

import { Route as meRoute } from "#/routes/api/me";
import { Route as onboardRoute } from "#/routes/api/onboard";
import { Route as opsRoute } from "#/routes/api/ops";
import { Route as syncRoute } from "#/routes/api/sync";
import { CLIENT_ID_HEADER } from "#/shared/contract";
import {
	type FakeEngine,
	FakeNextcloud,
	NC_PASS,
	NC_USER,
} from "#/test/fake-nextcloud.server";
import {
	migratedTestDatabase,
	type TestDatabase,
	testDatabaseUrl,
} from "#/test/postgres.server";
import { closeDb } from "../db/client.server";
import { setEngineFactoryForTests } from "./account.server";

type Handler = (ctx: { request: Request }) => Promise<Response>;

function handler(route: { options: unknown }, method: string): Handler {
	const options = route.options as {
		server: { handlers: Record<string, Handler> };
	};
	const fn = options.server.handlers[method];
	if (!fn) throw new Error(`no ${method} handler`);
	return fn;
}

const BASE = "http://localhost:3000";
const ENV_KEYS = ["DATABASE_URL", "DEV_USER", "TASKS_FERNET_KEY"] as const;

let pg: TestDatabase;
let nc: FakeNextcloud;
let engines: FakeEngine[];
const savedEnv: Record<string, string | undefined> = {};

function as(user: string | null): void {
	if (user === null) delete process.env.DEV_USER;
	else process.env.DEV_USER = user;
}

const getMe = () =>
	handler(meRoute, "GET")({ request: new Request(`${BASE}/api/me`) });

const postJson = (route: { options: unknown }, path: string, body: unknown) =>
	handler(
		route,
		"POST",
	)({
		request: new Request(`${BASE}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	});

const onboard = (appPassword = NC_PASS, ncUsername = NC_USER) =>
	postJson(onboardRoute, "/api/onboard", {
		nc_username: ncUsername,
		app_password: appPassword,
	});

const getSync = (cursor = "") =>
	handler(
		syncRoute,
		"GET",
	)({
		request: new Request(
			`${BASE}/api/sync?cursor=${encodeURIComponent(cursor)}`,
		),
	});

const postOps = (ops: unknown[], headers: Record<string, string> = {}) =>
	handler(
		opsRoute,
		"POST",
	)({
		request: new Request(`${BASE}/api/ops`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ ops }),
		}),
	});

async function envelope(
	res: Response,
): Promise<{ code: string; message: string }> {
	const body = (await res.json()) as {
		error: { code: string; message: string };
	};
	expect(Object.keys(body)).toEqual(["error"]);
	expect(Object.keys(body.error)).toEqual(["code", "message"]);
	expect(body.error.message).not.toBe("");
	return body.error;
}

describe.skipIf(!testDatabaseUrl)("/api routes", () => {
	beforeAll(async () => {
		for (const key of [...ENV_KEYS, "DATABASE_PASSWORD_FILE"]) {
			savedEnv[key] = process.env[key];
		}
		delete process.env.DATABASE_PASSWORD_FILE;
		pg = await migratedTestDatabase();
		process.env.DATABASE_URL = pg.url;
	}, 30_000);

	afterAll(async () => {
		setEngineFactoryForTests(undefined);
		await closeDb();
		await pg?.drop();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}, 30_000);

	beforeEach(async () => {
		await pg.client`truncate connected_accounts, applied_ops`;
		process.env.TASKS_FERNET_KEY = `${randomBytes(32).toString("base64url")}=`;
		as("viktor");
		nc = new FakeNextcloud();
		nc.addUser(NC_USER, NC_PASS);
		nc.addCalendar(NC_USER, "personal", "Personal");
		nc.addCalendar(NC_USER, "work", "Work");
		engines = [];
		setEngineFactoryForTests((user, password) => {
			const engine = nc.engine(user, password);
			engines.push(engine);
			return engine;
		});
	});

	afterEach(() => {
		// Every engine a request opened was closed again.
		expect(engines.every((engine) => engine.closed)).toBe(true);
	});

	describe("identity and the envelope", () => {
		test("no identity is a 401 envelope", async () => {
			as(null);
			const res = await getMe();
			expect(res.status).toBe(401);
			expect((await envelope(res)).code).toBe("unauthorized");
		});

		test("not connected is a 409 envelope on sync and ops", async () => {
			for (const res of [await getSync(), await postOps([])]) {
				expect(res.status).toBe(409);
				expect((await envelope(res)).code).toBe("not_connected");
			}
		});

		test("validation errors are 422 and never echo the app password", async () => {
			const secret = "super-secret-app-password";
			const res = await postJson(onboardRoute, "/api/onboard", {
				app_password: secret,
			});
			expect(res.status).toBe(422);
			const text = await res.text();
			expect(text).not.toContain(secret);
			const error = JSON.parse(text).error as { code: string; message: string };
			expect(error.code).toBe("validation_error");
			expect(error.message).toContain("nc_username");
		});

		test("an invalid ops body is a 422; an unknown kind is not", async () => {
			expect((await onboard()).status).toBe(204);
			const bad = await postJson(opsRoute, "/api/ops", { ops: "nope" });
			expect(bad.status).toBe(422);
			expect((await envelope(bad)).code).toBe("validation_error");
			const missingId = await postJson(opsRoute, "/api/ops", {
				ops: [{ kind: "list_create" }],
			});
			expect(missingId.status).toBe(422);
			const notJson = await postJson(opsRoute, "/api/ops", "{");
			expect(notJson.status).toBe(422);
			const unknown = await postOps([{ op_id: "z1", kind: "task_explode" }]);
			expect(unknown.status).toBe(200);
		});
	});

	describe("onboarding and /api/me", () => {
		test("valid credentials: 204 with no body, then connected", async () => {
			const res = await onboard();
			expect(res.status).toBe(204);
			expect(await res.text()).toBe("");
			const me = await getMe();
			expect(me.status).toBe(200);
			expect(await me.text()).toBe('{"username":"viktor","connected":true}');
		});

		test("a rejected app password is 401 and stores nothing", async () => {
			const res = await onboard("wrong");
			expect(res.status).toBe(401);
			expect((await envelope(res)).code).toBe("invalid_credentials");
			expect(await (await getMe()).json()).toEqual({
				username: "viktor",
				connected: false,
			});
			expect(await pg.client`select * from connected_accounts`).toEqual([]);
		});

		test("an unknown Nextcloud user is 401", async () => {
			expect((await onboard("whatever", "nobody")).status).toBe(401);
		});

		test("the stored password is Fernet ciphertext", async () => {
			await onboard();
			const [row] = await pg.client`
				select nc_username, convert_from(enc_app_password, 'SQL_ASCII') as token
				from connected_accounts where authentik_username = 'viktor'`;
			expect(row.nc_username).toBe(NC_USER);
			expect(row.token).toMatch(/^gAAAAA[A-Za-z0-9_=-]+$/);
			expect(row.token).not.toContain(NC_PASS);
		});

		test("re-onboarding rotates the credential in place", async () => {
			await onboard();
			nc.users.set(NC_USER, "fresh-app-password");
			const stale = await getSync();
			expect(stale.status).toBe(401);
			expect((await envelope(stale)).code).toBe("nextcloud_unauthorized");
			expect((await onboard("fresh-app-password")).status).toBe(204);
			expect((await getSync()).status).toBe(200);
			const rows =
				await pg.client`select authentik_username from connected_accounts`;
			expect(rows).toHaveLength(1);
		});

		test("no TASKS_FERNET_KEY is a 500 server_misconfigured", async () => {
			delete process.env.TASKS_FERNET_KEY;
			const res = await onboard();
			expect(res.status).toBe(500);
			expect((await envelope(res)).code).toBe("server_misconfigured");
		});

		test("accounts are per user", async () => {
			as("anca");
			expect((await onboard()).status).toBe(204);
			expect(
				((await (await getMe()).json()) as { connected: boolean }).connected,
			).toBe(true);
			as("viktor");
			expect(
				((await (await getMe()).json()) as { connected: boolean }).connected,
			).toBe(false);
		});
	});

	describe("GET /api/sync", () => {
		test("a full snapshot, then a quiet delta, in wire format", async () => {
			await onboard();
			const res = await getSync();
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");
			const text = await res.text();
			const cursor = (JSON.parse(text) as { cursor: string }).cursor;
			expect(text).toBe(
				`{"cursor":"${cursor}","full":true,"lists":[{"id":"personal","name":"Personal","order":null,"sort_mode":null,"deleted":false},{"id":"work","name":"Work","order":null,"sort_mode":null,"deleted":false}],"tasks":[]}`,
			);
			const delta = (await (await getSync(cursor)).json()) as { full: boolean };
			expect(delta.full).toBe(false);
		});
	});

	describe("POST /api/ops", () => {
		test("applies, journals in Postgres, and dedupes across requests", async () => {
			await onboard();
			const batch = [
				{ op_id: "b1", kind: "list_create", list_id: "garden", name: "Garden" },
				{ op_id: "b2", kind: "list_reorder", list_id: "garden", order: 3 },
			];
			const first = await postOps(batch);
			expect(first.status).toBe(200);
			expect(await first.text()).toBe(
				'{"results":[{"op_id":"b1","status":"applied","error":null},{"op_id":"b2","status":"applied","error":null}]}',
			);
			const replay = (await (await postOps(batch)).json()) as {
				results: Array<{ status: string }>;
			};
			expect(replay.results.map((r) => r.status)).toEqual([
				"duplicate",
				"duplicate",
			]);
			expect(nc.calendar(NC_USER, "garden").order).toBe(3);
			const rows = await pg.client`
				select authentik_username, op_id, kind, status from applied_ops order by op_id`;
			expect(rows).toEqual([
				{
					authentik_username: "viktor",
					op_id: "b1",
					kind: "list_create",
					status: "applied",
				},
				{
					authentik_username: "viktor",
					op_id: "b2",
					kind: "list_reorder",
					status: "applied",
				},
			]);
		});

		test("a journal row another request wrote first makes the op a duplicate", async () => {
			await onboard();
			await pg.client`
				insert into applied_ops (authentik_username, op_id, kind, status)
				values ('viktor', 'r1', 'list_reorder', 'applied')`;
			const res = (await (
				await postOps([
					{ op_id: "r1", kind: "list_reorder", list_id: "work", order: 1 },
				])
			).json()) as { results: Array<{ status: string }> };
			expect(res.results[0]?.status).toBe("duplicate");
			expect(nc.calendar(NC_USER, "work").order).toBeNull();
		});

		test("a revoked app password is a 401 envelope and journals nothing", async () => {
			await onboard();
			nc.users.set(NC_USER, "rotated-by-nextcloud");
			const res = await postOps([
				{ op_id: "op-1", kind: "list_create", list_id: "x", name: "X" },
			]);
			expect(res.status).toBe(401);
			expect((await envelope(res)).code).toBe("nextcloud_unauthorized");
			expect(await pg.client`select * from applied_ops`).toEqual([]);
		});

		test("the batch succeeds even when the realtime poke cannot be sent", async () => {
			// pokeUser is still a stub on this branch and throws; the poke is best effort.
			await onboard();
			const res = await postOps(
				[{ op_id: "p1", kind: "list_rename", list_id: "work", name: "Werk" }],
				{ [CLIENT_ID_HEADER]: "device-a" },
			);
			expect(res.status).toBe(200);
			expect(nc.calendar(NC_USER, "work").displayname).toBe("Werk");
		});

		test("an empty batch still needs a Connected Account, then returns []", async () => {
			await onboard();
			const res = await postOps([]);
			expect(await res.text()).toBe('{"results":[]}');
		});
	});
});
