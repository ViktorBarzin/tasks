/**
 * Prometheus metrics, served at /metrics on the pod port for in-cluster
 * scraping (prometheus.io/* annotations). /metrics is not routed through the
 * ingress (ADR-0001, Identity and access / Admin).
 */
import client from "prom-client";

export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
	name: "http_requests_total",
	help: "HTTP requests handled by the app server.",
	labelNames: ["method", "handler", "status"] as const,
	registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
	name: "http_request_duration_seconds",
	help: "HTTP request latency in seconds.",
	labelNames: ["method", "handler"] as const,
	buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
	registers: [registry],
});

/** 1 while the realtime LISTEN connection is up (ADR-0001, Realtime contract). */
export const realtimeListenConnected = new client.Gauge({
	name: "realtime_listen_connected",
	help: "1 while the Postgres LISTEN connection is connected.",
	registers: [registry],
});

/** Seconds since the last NOTIFY was received. Set by the realtime listener. */
export const realtimeLastNotifyAgeSeconds = new client.Gauge({
	name: "realtime_last_notify_age_seconds",
	help: "Seconds since the last Postgres NOTIFY was received.",
	registers: [registry],
});

/** Op outcomes, by kind and status (the Python logs carried these as `statuses`). */
export const opsAppliedTotal = new client.Counter({
	name: "tasks_ops_total",
	help: "Ops processed by POST /api/ops, by kind and status.",
	labelNames: ["kind", "status"] as const,
	registers: [registry],
});

/**
 * The `handler` label: known routes by name, everything else folded into a
 * few buckets so the label set stays small.
 */
const KNOWN_HANDLERS = new Set([
	"/api/me",
	"/api/onboard",
	"/api/sync",
	"/api/ops",
	"/api/signin",
	"/api/events",
	"/healthz",
	"/metrics",
]);

export function handlerLabel(pathname: string): string {
	if (KNOWN_HANDLERS.has(pathname)) return pathname;
	if (pathname.startsWith("/api/auth/")) return "/api/auth";
	if (pathname.startsWith("/api/")) return "/api/other";
	if (pathname.startsWith("/_serverFn/")) return "/_serverFn";
	return "page";
}

export async function metricsResponse(): Promise<Response> {
	return new Response(await registry.metrics(), {
		headers: { "content-type": registry.contentType },
	});
}
