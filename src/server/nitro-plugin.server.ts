/**
 * Nitro runtime plugin: runs once when the built server starts, before it
 * listens. Registered in vite.config.ts (`nitro({ plugins })`).
 *
 * - console output (Nitro's error handler, srvx's banner, uncaught errors)
 *   becomes JSON lines like the rest of the logs, with the service fields
 *   (service.name, service.version, deployment.environment.name) on every
 *   line;
 * - server telemetry starts when a write key is configured (ADR-0005):
 *   product events to the event pipeline, errors to GlitchTip with a DSN;
 * - /metrics is served on its own port (METRICS_PORT), which the ingress
 *   does not route, so it is never public (ADR-0001, Admin); every metric is
 *   registered now, so a scrape before the first request sees them all;
 * - the realtime LISTEN connection starts at boot (ADR-0001: each pod holds
 *   one), so its gauges mean something before the first SSE subscriber;
 * - SIGTERM/SIGINT close the SSE streams and the LISTEN connection, let
 *   in-flight requests finish (5 s at most), then send queued telemetry,
 *   close the metrics listener and the pool and exit, instead of waiting for
 *   Kubernetes' SIGKILL.
 */
import * as Sentry from "@sentry/bun";
import { authMetrics } from "@viktorbarzin/auth";
import {
	getLogger,
	installJsonConsole,
	setLogService,
} from "@viktorbarzin/log";
import { httpMetrics, startMetricsServer } from "@viktorbarzin/metrics";
import { realtimeGauges } from "@viktorbarzin/realtime/server";
import { installShutdown } from "@viktorbarzin/runtime";
import {
	closeAndFlush,
	initServerTelemetry,
} from "@viktorbarzin/telemetry/server";
import { definePlugin } from "nitro";

import {
	databaseConfigured,
	isDevelopment,
	metricsListen,
	serviceInfo,
	telemetrySettings,
} from "./config.server";
import { pool } from "./db/client.server";
import { appMetrics } from "./metrics.server";
import { realtime } from "./realtime/realtime.server";

export default definePlugin(() => {
	// Bun-only steps; `vite dev` may run the server outside Bun.
	if (typeof Bun === "undefined") return;
	setLogService(serviceInfo());
	if (!isDevelopment()) installJsonConsole();
	const telemetry = telemetrySettings();
	if (telemetry)
		initServerTelemetry({
			writeKey: telemetry.writeKey,
			host: telemetry.host,
			release: telemetry.release,
			service: serviceInfo().name,
			environment: telemetry.environment,
			dsn: telemetry.serverDsn ?? undefined,
			sentry: Sentry,
		});
	httpMetrics();
	authMetrics({ prefix: "tasks" });
	realtimeGauges();
	appMetrics();
	const metrics = startMetricsServer(metricsListen());
	if (databaseConfigured()) void realtime.start().catch(() => {});
	installShutdown({
		beforeDrain: [{ name: "realtime", run: () => realtime.stop() }],
		afterDrain: [
			{ name: "telemetry", run: () => closeAndFlush(2000) },
			{ name: "metrics", run: () => metrics?.stop() },
			{ name: "pool", run: () => pool.close() },
		],
		logger: getLogger("tasks.lifecycle"),
	});
});
