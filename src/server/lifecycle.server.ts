/**
 * Process lifecycle for the built server, wired up by the Nitro plugin in
 * src/server/nitro-plugin.server.ts:
 *
 * - every request may stay idle for REQUEST_IDLE_TIMEOUT_S, not Bun's default
 *   10 s, so a slow Nextcloud answer (the engine allows 30 s per CalDAV call)
 *   reaches the client instead of an empty reply;
 * - console output (Nitro's error handler, srvx's banner, uncaught errors)
 *   becomes JSON lines like the rest of the logs;
 * - /metrics is served on its own port (METRICS_PORT), which the ingress
 *   does not route, so it is never public (ADR-0001, Admin);
 * - the realtime LISTEN connection starts at boot (ADR-0001: each pod holds
 *   one), so its gauges mean something before the first SSE subscriber;
 * - SIGTERM/SIGINT close the SSE streams, the LISTEN connection and the pool,
 *   then exit, instead of waiting for Kubernetes' SIGKILL.
 */
import { format } from "node:util";

import { closeDb } from "./db/client.server";
import { getLogger, type LogLevel } from "./logging.server";
import { metricsResponse } from "./metrics.server";
import { getSseHub, stopSseHub } from "./realtime/hub.server";
import { processSingleton } from "./singleton.server";

const log = getLogger("tasks.lifecycle");

/** Longest a request may go without sending or receiving a byte. Bun's maximum is 255. */
export const REQUEST_IDLE_TIMEOUT_S = 120;

/** How long shutdown waits for in-flight requests before closing the pool. */
export const SHUTDOWN_DRAIN_MS = 5_000;

interface BunServerHandle {
	timeout(request: Request, seconds: number): void;
}
type BunRuntimeRequest = Request & {
	runtime?: { bun?: { server?: BunServerHandle } };
};

/**
 * Raise Bun's per-request idle timeout for this request. Returns false when
 * the request did not come through Bun.serve (tests, dev).
 */
export function extendIdleTimeout(
	request: Request,
	seconds: number = REQUEST_IDLE_TIMEOUT_S,
): boolean {
	const server = (request as BunRuntimeRequest).runtime?.bun?.server;
	if (typeof server?.timeout !== "function") return false;
	server.timeout(request, seconds);
	return true;
}

/** In-flight requests, once per process (src/server/singleton.server.ts). */
const requests = processSingleton("lifecycle.requests", () => ({
	inFlight: 0,
	drained: new Set<() => void>(),
}));

/** Count a request as in flight; call the returned function when it is answered. */
export function trackRequest(): () => void {
	requests.inFlight += 1;
	let done = false;
	return () => {
		if (done) return;
		done = true;
		requests.inFlight -= 1;
		if (requests.inFlight === 0)
			for (const resolve of [...requests.drained]) resolve();
	};
}

export function requestsInFlight(): number {
	return requests.inFlight;
}

/** Resolves when no request is in flight, or after `timeoutMs`. */
export function waitForDrain(timeoutMs: number): Promise<void> {
	if (requests.inFlight === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			requests.drained.delete(finish);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		requests.drained.add(finish);
	});
}

const CONSOLE_LEVELS: Record<string, LogLevel> = {
	error: "ERROR",
	warn: "WARNING",
	log: "INFO",
	info: "INFO",
	debug: "DEBUG",
	trace: "DEBUG",
};

/**
 * Route console.* through the JSON-lines logger (logger "console"). An Error
 * argument goes under `exc` with its stack, as one line.
 */
export function installJsonConsole(target: Console = console): () => void {
	const consoleLog = getLogger("console");
	const saved = new Map<string, unknown>();
	for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
		const key = method as keyof Console;
		saved.set(method, target[key]);
		(target as unknown as Record<string, unknown>)[method] = (
			...args: unknown[]
		) => {
			const err = args.find((arg) => arg instanceof Error);
			const rest = args.filter((arg) => arg !== err);
			const msg = rest.length > 0 ? format(...rest) : err ? String(err) : "";
			consoleLog.record(level, msg, undefined, err);
		};
	}
	return () => {
		for (const [method, fn] of saved)
			(target as unknown as Record<string, unknown>)[method] = fn;
	};
}

interface MetricsServer {
	port: number;
	stop(): void;
}

/**
 * Serve /metrics on METRICS_PORT (bound to HOST), or nothing when it is unset.
 * The image sets METRICS_PORT=9090 and the pod's prometheus.io/port points at it.
 */
export function startMetricsServer(
	env: Record<string, string | undefined> = process.env,
): MetricsServer | null {
	const raw = env.METRICS_PORT;
	if (!raw) return null;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		log.error("METRICS_PORT is not a port; metrics are not served", {
			value: raw,
		});
		return null;
	}
	try {
		const server = Bun.serve({
			hostname: env.HOST || "0.0.0.0",
			port,
			fetch: (request) =>
				new URL(request.url).pathname === "/metrics"
					? metricsResponse()
					: new Response("not found\n", { status: 404 }),
		});
		log.info("metrics listening", { port: server.port });
		return {
			port: server.port as number,
			stop: () => void server.stop(true),
		};
	} catch (err) {
		log.exception("metrics server failed to start", err, { port });
		return null;
	}
}

/** Open the LISTEN connection now, when a database is configured. */
export function startRealtimeAtBoot(
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!env.DATABASE_URL) return false;
	getSseHub();
	return true;
}

export interface ShutdownDeps {
	stopRealtime: () => Promise<void>;
	closeDb: () => Promise<void>;
	stopMetrics: () => void;
	drainMs: number;
	exit: (code: number) => void;
}

/**
 * The shutdown sequence: close the SSE streams and the LISTEN connection (the
 * streams would hold the server's graceful close open), let in-flight
 * requests finish, close the pool, exit.
 */
export async function shutdown(signal: string, deps: ShutdownDeps) {
	log.info("shutting down", { signal, in_flight: requestsInFlight() });
	try {
		await deps.stopRealtime();
		await waitForDrain(deps.drainMs);
		deps.stopMetrics();
		await deps.closeDb();
	} catch (err) {
		log.exception("shutdown cleanup failed", err);
	} finally {
		deps.exit(0);
	}
}

const shutdownState = processSingleton("lifecycle.shutdown", () => ({
	installed: false,
	shuttingDown: false,
}));

/** Register the SIGTERM/SIGINT handler once. */
export function installShutdown(metrics: MetricsServer | null): void {
	if (shutdownState.installed) return;
	shutdownState.installed = true;
	const onSignal = (signal: NodeJS.Signals) => {
		if (shutdownState.shuttingDown) return;
		shutdownState.shuttingDown = true;
		void shutdown(signal, {
			stopRealtime: stopSseHub,
			closeDb,
			stopMetrics: () => metrics?.stop(),
			drainMs: SHUTDOWN_DRAIN_MS,
			exit: (code) => process.exit(code),
		});
	};
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
}
