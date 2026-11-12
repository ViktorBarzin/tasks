/**
 * Product events on the built server (`bun run build` first) with a real
 * Postgres (TEST_DATABASE_URL), the fake Nextcloud and a fake event pipeline
 * behind TELEMETRY_HOST (ADR-0005): onboarding and an applied task_create
 * each send one event, carrying the browser's visitor id, IP and User-Agent,
 * and the queue is sent on SIGTERM.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { TestDatabase } from "@viktorbarzin/pg/testing";

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

const WRITE_KEY = "test-write-key";
const VISITOR = "visitor-123";
const BROWSER_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

interface Message {
	type: string;
	event?: string;
	userId?: string;
	anonymousId?: string;
	properties?: Record<string, unknown>;
	context?: { ip?: string; userAgent?: string; app?: { name?: string } };
}

let database: TestDatabase;
let server: BuiltServer;
let dav: ReturnType<typeof Bun.serve>;
let pipeline: ReturnType<typeof Bun.serve>;
const received: { auth: string | null; batch: Message[] }[] = [];

beforeAll(async () => {
	if (!ready) return;
	database = await testDatabase(adminUrl as string);
	const fake = seededFakeNextcloud();
	dav = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => fake.handler(request),
	});
	pipeline = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { batch: Message[] };
			received.push({
				auth: request.headers.get("authorization"),
				batch: body.batch,
			});
			return Response.json({ success: true });
		},
	});
	server = await startBuiltServer(
		{
			DATABASE_URL: database.url,
			DEV_USER: "viktor",
			TASKS_FERNET_KEY: `${randomBytes(32).toString("base64url")}=`,
			TASKS_CALDAV_BASE_URL: `http://127.0.0.1:${dav.port}/remote.php/dav`,
			TELEMETRY_WRITE_KEY: WRITE_KEY,
			TELEMETRY_HOST: `http://127.0.0.1:${pipeline.port}`,
			SERVICE_VERSION: "abcd1234",
		},
		{ origin: (port) => ({ PUBLIC_ORIGINS: `http://127.0.0.1:${port}` }) },
	);
}, 30_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await dav?.stop(true);
	await pipeline?.stop(true);
	await database?.drop();
});

function browserHeaders(): Record<string, string> {
	return {
		"content-type": "application/json",
		origin: server.origin,
		"user-agent": BROWSER_UA,
		"x-real-ip": "81.2.69.142",
		"x-visitor-id": VISITOR,
	};
}

describe.skipIf(!ready)("product events from the built server", () => {
	test("onboarding and an applied task_create reach the pipeline on SIGTERM", async () => {
		const onboard = await fetch(`${server.origin}/api/onboard`, {
			method: "POST",
			headers: browserHeaders(),
			body: JSON.stringify({ nc_username: NC_USER, app_password: NC_PASS }),
		});
		expect(onboard.status).toBe(204);
		const ops = await fetch(`${server.origin}/api/ops`, {
			method: "POST",
			headers: browserHeaders(),
			body: JSON.stringify({
				ops: [
					{
						op_id: "c1",
						kind: "task_create",
						uid: "telemetry-1",
						list_id: "work",
						title: "Bread",
						due: "2026-07-10",
						due_has_time: false,
						priority: 1,
					},
				],
			}),
		});
		expect(ops.status).toBe(200);

		server.kill("SIGTERM");
		expect(await server.exited).toBe(0);

		const messages = received.flatMap((r) => r.batch);
		expect(
			received.every(
				(r) =>
					r.auth === `Basic ${Buffer.from(`${WRITE_KEY}:`).toString("base64")}`,
			),
		).toBe(true);
		expect(messages.map((m) => [m.type, m.event, m.properties])).toEqual([
			["track", "account.connected", {}],
			["track", "task.created", { has_due_date: true, priority: 1 }],
		]);
		for (const m of messages) {
			// The dev user has no sub, so the browser's visitor id is the person.
			expect(m.userId).toBeUndefined();
			expect(m.anonymousId).toBe(VISITOR);
			expect(m.context?.ip).toBe("81.2.69.142");
			expect(m.context?.userAgent).toBe(BROWSER_UA);
			expect(m.context?.app?.name).toBe("tasks");
		}
	}, 30_000);
});
