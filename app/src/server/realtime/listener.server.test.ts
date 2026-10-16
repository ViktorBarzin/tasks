/**
 * The LISTEN connection against a real Postgres (TEST_DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

import { TestDatabases } from "../auth/testing/built-server";
import { registry } from "../metrics.server";
import { createListener } from "./listener.server";
import type { RealtimeMessage } from "./notify.server";

const adminUrl = process.env.TEST_DATABASE_URL;
let dbs: TestDatabases;
let url: string;
let admin: SQL;

beforeAll(async () => {
	if (!adminUrl) return;
	dbs = new TestDatabases(adminUrl);
	url = await dbs.create();
	admin = new SQL({ url, max: 2 });
});

afterAll(async () => {
	if (!adminUrl) return;
	await admin.close();
	await dbs.dropAll();
});

async function gauge(name: string): Promise<number> {
	const metric = await registry.getSingleMetric(name)?.get();
	return metric?.values[0]?.value ?? Number.NaN;
}

function collector() {
	const seen: RealtimeMessage[] = [];
	const waitFor = async (
		pred: (m: RealtimeMessage) => boolean,
		timeoutMs = 10_000,
	) => {
		const deadline = Date.now() + timeoutMs;
		while (!seen.some(pred)) {
			if (Date.now() > deadline)
				throw new Error(`not seen; got ${JSON.stringify(seen)}`);
			await Bun.sleep(20);
		}
	};
	return { seen, waitFor };
}

async function listenPid(channel: string): Promise<number> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const rows = await admin`
			select pid from pg_stat_activity
			where datname = current_database() and query ilike ${`listen%${channel}%`}`;
		if (rows.length > 0) return rows[0].pid;
		if (Date.now() > deadline) throw new Error("no LISTEN backend");
		await Bun.sleep(50);
	}
}

describe.skipIf(!adminUrl)("realtime listener", () => {
	test("relays notifications and keeps the gauges", async () => {
		const channel = "tasks_ops_t1";
		const listener = createListener(channel, {
			createClient: () => new SQL({ url, max: 1, idleTimeout: 0 }),
			notify: (c, p) => admin.notify(c, p),
		});
		const { seen, waitFor } = collector();
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		expect(await gauge("realtime_listen_connected")).toBe(1);

		await admin.notify(channel, "garbage");
		await admin.notify(
			channel,
			JSON.stringify({
				account_key: "viktor",
				event: { type: "poke", source_client_id: null },
			}),
		);
		await waitFor((m) => m.event.type === "poke");
		expect(seen).toEqual([
			{
				account_key: "viktor",
				event: { type: "poke", source_client_id: null },
			},
		]);
		expect(await gauge("realtime_last_notify_age_seconds")).toBeLessThan(5);
		await listener.stop();
		expect(await gauge("realtime_listen_connected")).toBe(0);
	});

	test("uses one LISTEN connection", async () => {
		const channel = "tasks_ops_t2";
		const listener = createListener(channel, {
			createClient: () =>
				new SQL({
					url,
					max: 1,
					idleTimeout: 0,
					connection: { application_name: "listener-t2" },
				}),
			notify: (c, p) => admin.notify(c, p),
		});
		await listener.start();
		const rows =
			await admin`select count(*)::int as n from pg_stat_activity where application_name = 'listener-t2'`;
		expect(rows[0].n).toBe(1);
		await listener.stop();
	});

	test("a dropped connection is re-established and clients are told to resync", async () => {
		const channel = "tasks_ops_t3";
		const listener = createListener(channel, {
			createClient: () => new SQL({ url, max: 1, idleTimeout: 0 }),
			notify: (c, p) => admin.notify(c, p),
		});
		const { seen, waitFor } = collector();
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		const pid = await listenPid(channel);
		await admin`select pg_terminate_backend(${pid})`;
		await waitFor((m) => m.event.type === "resync");
		// And it listens again.
		await admin.notify(
			channel,
			JSON.stringify({ account_key: "a", event: { type: "resync" } }),
		);
		await waitFor((m) => m.account_key === "a");
		await listener.stop();
	}, 20_000);

	test("a heartbeat that does not come back forces a reconnect and a resync", async () => {
		const channel = "tasks_ops_t4";
		let clients = 0;
		const listener = createListener(channel, {
			createClient: () => {
				clients += 1;
				return new SQL({ url, max: 1, idleTimeout: 0 });
			},
			// The ping is sent on a channel nobody listens on: it never comes back,
			// as when the LISTEN socket is half-open.
			notify: (_c, p) => admin.notify(`${channel}_void`, p),
			pingIntervalMs: 100,
			pingTimeoutMs: 100,
			backoffMs: () => 50,
		});
		const { seen, waitFor } = collector();
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		await waitFor((m) => m.event.type === "resync", 5_000);
		expect(clients).toBeGreaterThanOrEqual(2);
		await listener.stop();
	}, 20_000);

	test("a heartbeat that comes back keeps the connection", async () => {
		const channel = "tasks_ops_t5";
		let clients = 0;
		const listener = createListener(channel, {
			createClient: () => {
				clients += 1;
				return new SQL({ url, max: 1, idleTimeout: 0 });
			},
			notify: (c, p) => admin.notify(c, p),
			pingIntervalMs: 50,
			pingTimeoutMs: 1_000,
		});
		const seen: RealtimeMessage[] = [];
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		await Bun.sleep(600);
		expect(clients).toBe(1);
		expect(seen).toEqual([]);
		await listener.stop();
	});

	test("start retries until Postgres is reachable", async () => {
		let attempts = 0;
		const listener = createListener("tasks_ops_t6", {
			createClient: () => {
				attempts += 1;
				return attempts < 3
					? new SQL({
							url: "postgres://nobody:x@127.0.0.1:1/none",
							max: 1,
							connectionTimeout: 1,
						})
					: new SQL({ url, max: 1, idleTimeout: 0 });
			},
			notify: (c, p) => admin.notify(c, p),
			backoffMs: () => 20,
		});
		await listener.start();
		expect(attempts).toBe(3);
		await listener.stop();
	}, 20_000);
});
