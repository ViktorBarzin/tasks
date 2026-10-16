/**
 * Nitro runtime plugin: runs once when the built server starts, before it
 * listens. Registered in vite.config.ts (`nitro({ plugins })`). See
 * src/server/lifecycle.server.ts for what each step is for.
 */
import { definePlugin } from "nitro";

import {
	installJsonConsole,
	installShutdown,
	startMetricsServer,
	startRealtimeAtBoot,
} from "./lifecycle.server";

export default definePlugin(() => {
	// Bun-only steps; `vite dev` may run the server outside Bun.
	if (typeof Bun === "undefined") return;
	if (process.env.NODE_ENV !== "development") installJsonConsole();
	const metrics = startMetricsServer();
	startRealtimeAtBoot();
	installShutdown(metrics);
});
