/**
 * Realtime pokes (ADR-0001, Realtime contract) on @viktorbarzin/realtime: one
 * LISTEN connection per pod on `tasks_ops`, an SSE stream per open tab or
 * device keyed by the user's account key, and pg_notify to publish.
 *
 * For tasks the event is a poke: after POST /api/ops applies a batch, the
 * same user's other open devices are told to run a delta sync. The NOTIFY
 * queue is shared by every database on the cluster, so a payload names the
 * user and nothing else, never task data.
 */
import { getLogger } from "@viktorbarzin/log";
import { createSqlClient } from "@viktorbarzin/pg";
import {
	createRealtime,
	poolNotify,
	sanitizeClientId,
} from "@viktorbarzin/realtime/server";

import type { RealtimeEvent } from "#/shared/contract";
import { pgSettings } from "../config.server";
import { pool } from "../db/client.server";

/** The LISTEN/NOTIFY channel this app uses. */
export const REALTIME_CHANNEL = "tasks_ops";

/** Accepts the two tasks event shapes, nothing else. */
export function parseTasksEvent(raw: unknown): RealtimeEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const event = raw as Record<string, unknown>;
	if (event.type === "resync") return { type: "resync" };
	if (event.type !== "poke") return null;
	const source = event.source_client_id;
	return {
		type: "poke",
		source_client_id:
			typeof source === "string" ? sanitizeClientId(source) : null,
	};
}

export const realtime = createRealtime<RealtimeEvent>(() => ({
	channel: REALTIME_CHANNEL,
	createListenClient: () =>
		createSqlClient(pgSettings(), { max: 1, idleTimeout: 0 }),
	notify: poolNotify(() => pool.getClient()),
	parseEvent: parseTasksEvent,
	logger: getLogger("tasks.realtime"),
}));

/**
 * Tell every pod that `accountKey`'s data changed, so that user's open
 * devices run a delta sync. Never throws: a lost poke only delays a sync
 * until the next focus or reconnect, and must not fail the op batch.
 */
export function pokeUser(
	accountKey: string,
	sourceClientId: string | null,
): Promise<void> {
	return realtime.publish(accountKey, {
		type: "poke",
		source_client_id: sanitizeClientId(sourceClientId),
	});
}
