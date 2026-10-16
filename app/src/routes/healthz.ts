import { createFileRoute } from "@tanstack/react-router";

/** Liveness and readiness probe: `{"status": "ok"}`, as the FastAPI app served. */
export const Route = createFileRoute("/healthz")({
	server: {
		handlers: {
			GET: () => Response.json({ status: "ok" }),
		},
	},
});
