import { createFileRoute } from "@tanstack/react-router";

import { metricsResponse } from "#/server/metrics.server";

/** Prometheus scrape endpoint on the pod port. Not routed through the ingress. */
export const Route = createFileRoute("/metrics")({
	server: {
		handlers: {
			GET: () => metricsResponse(),
		},
	},
});
