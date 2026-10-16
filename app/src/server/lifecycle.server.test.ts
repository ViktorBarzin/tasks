import { afterEach, describe, expect, test } from "bun:test";

import {
	extendIdleTimeout,
	installJsonConsole,
	requestsInFlight,
	shutdown,
	startMetricsServer,
	trackRequest,
	waitForDrain,
} from "./lifecycle.server";
import { setLogLevel, setLogSink } from "./logging.server";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
});

describe("installJsonConsole", () => {
	test("console output becomes one JSON line, an Error's stack under exc", () => {
		const lines: string[] = [];
		cleanups.push(setLogSink((line) => lines.push(line)));
		setLogLevel("DEBUG");
		cleanups.push(() => setLogLevel("WARNING"));
		const target = { ...console } as Console;
		cleanups.push(installJsonConsole(target));
		target.log("➜ Listening on: %s", "http://localhost:3000/");
		target.error(
			"[request error]",
			new Error("Server function info not found"),
		);
		target.warn({ nested: { a: 1 } });
		const records = lines.map((line) => JSON.parse(line));
		expect(records.map((r) => [r.level, r.logger])).toEqual([
			["INFO", "console"],
			["ERROR", "console"],
			["WARNING", "console"],
		]);
		expect(records[0].msg).toBe("➜ Listening on: http://localhost:3000/");
		expect(records[1].msg).toBe("[request error]");
		expect(records[1].exc).toContain("Error: Server function info not found");
		expect(records[1].exc).toContain("\n    at ");
		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
	});
});

describe("extendIdleTimeout", () => {
	test("raises the request's idle timeout through Bun's server", () => {
		const calls: [Request, number][] = [];
		const request = new Request("http://app.invalid/api/sync");
		Object.defineProperty(request, "runtime", {
			value: {
				bun: {
					server: { timeout: (r: Request, s: number) => calls.push([r, s]) },
				},
			},
		});
		expect(extendIdleTimeout(request)).toBe(true);
		expect(calls).toEqual([[request, 120]]);
		expect(extendIdleTimeout(new Request("http://app.invalid/"))).toBe(false);
	});
});

describe("graceful shutdown", () => {
	test("waits for in-flight requests, then closes realtime, metrics and the pool, then exits 0", async () => {
		const order: string[] = [];
		const done = trackRequest();
		expect(requestsInFlight()).toBe(1);
		setTimeout(() => {
			order.push("request answered");
			done();
		}, 30);
		await shutdown("SIGTERM", {
			stopRealtime: async () => {
				order.push("realtime");
			},
			stopMetrics: () => order.push("metrics"),
			closeDb: async () => {
				order.push("db");
			},
			drainMs: 2_000,
			exit: (code) => order.push(`exit ${code}`),
		});
		expect(order).toEqual([
			"realtime",
			"request answered",
			"metrics",
			"db",
			"exit 0",
		]);
		expect(requestsInFlight()).toBe(0);
	});

	test("a request that never finishes delays shutdown only by drainMs", async () => {
		const done = trackRequest();
		const started = Date.now();
		await waitForDrain(50);
		expect(Date.now() - started).toBeLessThan(1_000);
		done();
		done(); // idempotent
		expect(requestsInFlight()).toBe(0);
	});

	test("exits even when cleanup throws", async () => {
		const exits: number[] = [];
		await shutdown("SIGTERM", {
			stopRealtime: async () => {
				throw new Error("LISTEN already gone");
			},
			stopMetrics: () => {},
			closeDb: async () => {},
			drainMs: 0,
			exit: (code) => exits.push(code),
		});
		expect(exits).toEqual([0]);
	});
});

describe("startMetricsServer", () => {
	test("serves /metrics only, on its own port, and nothing when METRICS_PORT is unset", async () => {
		expect(startMetricsServer({})).toBeNull();
		const server = startMetricsServer({ METRICS_PORT: "0", HOST: "127.0.0.1" });
		expect(server).not.toBeNull();
		cleanups.push(() => server?.stop());
		const base = `http://127.0.0.1:${server?.port}`;
		const metrics = await fetch(`${base}/metrics`);
		expect(metrics.status).toBe(200);
		expect(await metrics.text()).toContain("process_cpu_user_seconds_total");
		expect((await fetch(`${base}/`)).status).toBe(404);
	});
});
