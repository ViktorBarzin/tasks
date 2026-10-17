/**
 * The built server's process lifecycle over HTTP (`bun run build` first) with
 * a real Postgres (TEST_DATABASE_URL) and the ported fake Nextcloud as an HTTP
 * server: Bun's idle timeout, /metrics on its own port, the LISTEN connection
 * at boot, JSON-only console output and a prompt exit on SIGTERM.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { TestDatabase } from "@viktorbarzin/pg/testing";
import { SQL } from "bun";

import {
	type BuiltServer,
	builtServerExists,
	startBuiltServer,
	testDatabase,
} from "#/test/built-server";
import {
	NC_PASS,
	NC_USER,
	seededFakeNextcloud,
} from "./caldav/testing/fixtures.server";

const adminUrl = process.env.TEST_DATABASE_URL;
const ready = Boolean(adminUrl) && builtServerExists();

let database: TestDatabase;
let sql: SQL;
let server: BuiltServer;
let dav: ReturnType<typeof Bun.serve>;
/** The next CalDAV request waits this long before it is answered. */
let delayNextMs = 0;

beforeAll(async () => {
	if (!ready) return;
	database = await testDatabase(adminUrl as string);
	const { url } = database;
	sql = new SQL({ url, max: 2 });

	const fake = seededFakeNextcloud();
	dav = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			const delay = delayNextMs;
			delayNextMs = 0;
			if (delay > 0) await Bun.sleep(delay);
			return fake.handler(request);
		},
	});
	server = await startBuiltServer(
		{
			DATABASE_URL: url,
			DEV_USER: "viktor",
			TASKS_FERNET_KEY: `${randomBytes(32).toString("base64url")}=`,
			TASKS_CALDAV_BASE_URL: `http://127.0.0.1:${dav.port}/remote.php/dav`,
		},
		{ origin: (port) => ({ PUBLIC_ORIGINS: `http://127.0.0.1:${port}` }) },
	);
}, 30_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await dav?.stop(true);
	await sql?.close();
	await database?.drop();
});

async function metricsText(): Promise<string> {
	return (await fetch(`${server.metricsOrigin}/metrics`)).text();
}

describe.skipIf(!ready)("the built server's lifecycle", () => {
	test("the LISTEN connection opens at boot, before any SSE subscriber", async () => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const rows = await sql`
				select pid from pg_stat_activity
				where datname = current_database() and query ilike 'listen%tasks_ops%'`;
			if (
				/^realtime_listen_connected 1$/m.test(await metricsText()) &&
				rows.length > 0
			)
				break;
			if (Date.now() > deadline)
				throw new Error(`no LISTEN at boot:\n${await metricsText()}`);
			await Bun.sleep(100);
		}
	});

	test("the SSE route uses the LISTEN connection opened at boot, not a second one", async () => {
		const controller = new AbortController();
		const events = await fetch(`${server.origin}/api/events`, {
			signal: controller.signal,
			headers: { accept: "text/event-stream" },
		});
		expect(events.status).toBe(200);
		await (events.body as ReadableStream<Uint8Array>).getReader().read();
		await Bun.sleep(500);
		const rows = await sql`
			select pid from pg_stat_activity
			where datname = current_database() and query ilike 'listen%tasks_ops%'`;
		controller.abort();
		expect(rows).toHaveLength(1);
	});

	test("/metrics is served on METRICS_PORT and not on the app port", async () => {
		await fetch(`${server.origin}/api/me`);
		const text = await metricsText();
		expect(text).toContain("process_cpu_user_seconds_total");
		// Requests are recorded in the Start bundle and served from the Nitro
		// entry's listener: one registry for the process.
		expect(text).toMatch(
			/^http_requests_total\{method="GET",handler="\/api\/me",status="2xx"\} [1-9]/m,
		);
		const publicRes = await fetch(`${server.origin}/metrics`);
		expect(await publicRes.text()).not.toContain(
			"process_cpu_user_seconds_total",
		);
		expect((await fetch(`${server.metricsOrigin}/api/me`)).status).toBe(404);
	});

	test("a request slower than Bun's 10 s default still gets its answer", async () => {
		const onboard = await fetch(`${server.origin}/api/onboard`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: server.origin },
			body: JSON.stringify({ nc_username: NC_USER, app_password: NC_PASS }),
		});
		expect(onboard.status).toBe(204);
		delayNextMs = 16_000;
		const started = Date.now();
		const res = await fetch(`${server.origin}/api/sync?cursor=`);
		expect(Date.now() - started).toBeGreaterThanOrEqual(15_000);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { lists: unknown[] };
		expect(body.lists.length).toBeGreaterThan(0);
	}, 40_000);

	test("errors and console output reach stderr as JSON lines", async () => {
		const res = await fetch(`${server.origin}/_serverFn/garbage`, {
			method: "POST",
			headers: { origin: server.origin, "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		await Bun.sleep(200);
		const notJson = server.logs.filter((line) => {
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				return !(record.ts && record.level && record.logger && "msg" in record);
			} catch {
				return true;
			}
		});
		expect(notJson).toEqual([]);
	});

	test("SIGTERM exits promptly even after an SSE stream was open", async () => {
		const controller = new AbortController();
		const events = await fetch(`${server.origin}/api/events`, {
			signal: controller.signal,
			headers: { accept: "text/event-stream" },
		});
		expect(events.status).toBe(200);
		const reader = (events.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		const started = Date.now();
		server.kill("SIGTERM");
		const code = await Promise.race([
			server.exited,
			Bun.sleep(8_000).then(() => "still running"),
		]);
		expect(code).toBe(0);
		expect(Date.now() - started).toBeLessThan(6_000);
		controller.abort();
	}, 15_000);
});
