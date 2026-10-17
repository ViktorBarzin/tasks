/**
 * tasks' own Prometheus metrics, on the process registry from
 * @viktorbarzin/metrics (served at /metrics on METRICS_PORT, which the
 * ingress does not route). Created once per process: the Nitro entry and the
 * Start SSR bundle are separate module graphs.
 */
import { getRegistry } from "@viktorbarzin/metrics";
import { processSingleton } from "@viktorbarzin/runtime";
import client from "prom-client";

export function appMetrics() {
	return processSingleton("tasks.metrics", () => ({
		/** Op outcomes, by kind and status (the Python logs carried these as `statuses`). */
		opsAppliedTotal: new client.Counter({
			name: "tasks_ops_total",
			help: "Ops processed by POST /api/ops, by kind and status.",
			labelNames: ["kind", "status"] as const,
			registers: [getRegistry()],
		}),
	}));
}
