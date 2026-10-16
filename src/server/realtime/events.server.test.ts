/**
 * GET /api/events over HTTP against the built server (`bun run build` first)
 * and a real Postgres (TEST_DATABASE_URL): the ADR-0001 realtime contract end
 * to end, from a NOTIFY on tasks_ops to an SSE frame.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

import {
	type BuiltServer,
	builtServerExists,
	startBuiltServer,
	TestDatabases,
} from "../auth/testing/built-server";

const adminUrl = process.env.TEST_DATABASE_URL;
const ready = Boolean(adminUrl) && builtServerExists();
let dbs: TestDatabases;
let sql: SQL;
let server: BuiltServer;

beforeAll(async () => {
	if (!ready) return;
	dbs = new TestDatabases(adminUrl as string);
	const url = await dbs.create();
	sql = new SQL({ url, max: 2 });
	server = await startBuiltServer({ DATABASE_URL: url, DEV_USER: "dev-user" });
}, 30_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await sql?.close();
	await dbs.dropAll();
});

class SseReader {
	text = "";
	private readonly decoder = new TextDecoder();
	closed = false;
	constructor(
		private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
	) {
		void this.pump();
	}
	private async pump() {
		for (;;) {
			const { done, value } = await this.reader
				.read()
				.catch(() => ({ done: true, value: undefined }));
			if (done) {
				this.closed = true;
				return;
			}
			this.text += this.decoder.decode(value);
		}
	}
	async waitFor(needle: string | RegExp, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const hit = () =>
			typeof needle === "string"
				? this.text.includes(needle)
				: needle.test(this.text);
		while (!hit()) {
			if (this.closed)
				throw new Error(`stream closed; got ${JSON.stringify(this.text)}`);
			if (Date.now() > deadline)
				throw new Error(`timed out; got ${JSON.stringify(this.text)}`);
			await Bun.sleep(25);
		}
	}
}

async function open(): Promise<{
	res: Response;
	sse: SseReader;
	abort: () => void;
}> {
	const controller = new AbortController();
	const res = await fetch(`${server.origin}/api/events`, {
		signal: controller.signal,
		headers: { accept: "text/event-stream" },
	});
	const sse = new SseReader(
		(res.body as ReadableStream<Uint8Array>).getReader(),
	);
	return { res, sse, abort: () => controller.abort() };
}

/**
 * The LISTEN backend's pid, once the server reports the LISTEN acknowledged
 * (the query shows in pg_stat_activity slightly before that).
 */
async function listenerUp(): Promise<number> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const metrics = await (
			await fetch(`${server.metricsOrigin}/metrics`)
		).text();
		const rows = await sql`
			select pid from pg_stat_activity
			where datname = current_database() and query ilike 'listen%tasks_ops%'`;
		if (/^realtime_listen_connected 1$/m.test(metrics) && rows.length > 0)
			return rows[0].pid;
		if (Date.now() > deadline) throw new Error("the server never listened");
		await Bun.sleep(50);
	}
}

describe.skipIf(!ready)("GET /api/events", () => {
	test("streams with the SSE headers and a retry hint", async () => {
		const { res, sse, abort } = await open();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("text/event-stream");
		expect(res.headers.get("cache-control")).toContain("no-cache");
		await sse.waitFor("retry: 3000\n");
		abort();
	});

	test("a NOTIFY for this user becomes a poke; another user's does not", async () => {
		const { sse, abort } = await open();
		await sse.waitFor("connected");
		await listenerUp();
		await sql.notify(
			"tasks_ops",
			JSON.stringify({
				account_key: "someone-else",
				event: { type: "poke", source_client_id: null },
			}),
		);
		await sql.notify(
			"tasks_ops",
			JSON.stringify({
				account_key: "dev-user",
				event: { type: "poke", source_client_id: "tab-7" },
			}),
		);
		await sse.waitFor(
			'event: poke\ndata: {"type":"poke","source_client_id":"tab-7"}',
		);
		expect(sse.text.match(/event: poke/g)).toHaveLength(1);
		abort();
	});

	test("after the LISTEN connection drops, every stream gets a resync", async () => {
		const { sse, abort } = await open();
		await sse.waitFor("connected");
		const pid = await listenerUp();
		await sql`select pg_terminate_backend(${pid})`;
		try {
			await sse.waitFor("event: resync", 15_000);
		} finally {
			abort();
		}
	}, 20_000);

	test("an idle stream stays open past the server's idle timeout and gets a heartbeat at 25 s", async () => {
		const { sse, abort } = await open();
		await sse.waitFor("connected");
		await sse.waitFor(": ping\n\n", 30_000);
		expect(sse.closed).toBe(false);
		await sql.notify(
			"tasks_ops",
			JSON.stringify({ account_key: "dev-user", event: { type: "resync" } }),
		);
		await sse.waitFor("event: resync");
		abort();
	}, 40_000);

	test("the gauges are exported on /metrics", async () => {
		const text = await (await fetch(`${server.metricsOrigin}/metrics`)).text();
		expect(text).toMatch(/^realtime_listen_connected 1$/m);
		expect(text).toMatch(/^realtime_last_notify_age_seconds \d/m);
	});
});
