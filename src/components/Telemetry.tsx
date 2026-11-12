/**
 * Starts browser telemetry once per document (@viktorbarzin/telemetry/browser,
 * ADR-0005): the Rybbit script, the Segment client and, with a DSN, Sentry.
 * It does nothing off the production hosts. Sentry loads as its own chunk,
 * only when a DSN is configured.
 *
 * The page is a client-only shell that the service worker serves offline, so
 * the settings come from a server function after the page loads, never from
 * the cached shell. Offline the call fails and the page runs without
 * telemetry. `personId` identifies a signed-in person on every load, so a
 * session that started signed in is theirs too. tasks has no sign-out, so
 * nothing calls `reset()`.
 */
import { initTelemetry } from "@viktorbarzin/telemetry/browser";
import { useEffect } from "react";

import { getTelemetrySettings } from "#/server/telemetry.functions";

export function Telemetry() {
	useEffect(() => {
		let cancelled = false;
		void getTelemetrySettings()
			.then(async (settings) => {
				if (!settings || cancelled) return;
				const sentry = settings.dsn
					? await import("#/client/sentry")
					: undefined;
				initTelemetry({
					writeKey: settings.writeKey,
					siteId: settings.siteId,
					release: settings.release,
					environment: settings.environment,
					productionHosts: settings.productionHosts,
					dsn: settings.dsn ?? undefined,
					sentry,
					personId: settings.personId ?? undefined,
				});
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	return null;
}
