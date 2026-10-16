/**
 * Sending realtime events (ADR-0001, Realtime). For `tasks` the event is a
 * poke: after POST /api/ops applies a batch, the same user's other open
 * devices are told to run a delta sync (Pilot / Realtime in the pilot).
 *
 * Events go through Postgres `pg_notify(channel, payload)` so every pod's
 * listener sees them. The NOTIFY queue is shared by every database on the
 * cluster and payloads are capped at 8000 bytes: keep messages tiny.
 */
import type { RealtimeEvent } from "#/shared/contract";
import { notImplemented } from "../not-implemented.server";

/** The LISTEN/NOTIFY channel this app uses. */
export const REALTIME_CHANNEL = "tasks_events";

/** What travels in a NOTIFY payload (JSON). `account_key` routes it to that user's SSE streams. */
export interface RealtimeMessage {
	account_key: string | null;
	event: RealtimeEvent;
}

/** pg_notify one message on REALTIME_CHANNEL using the app pool. */
export async function notify(message: RealtimeMessage): Promise<void> {
	void message;
	return notImplemented("notify");
}

/** The poke sent after an op batch applied at least one op. */
export async function pokeUser(
	accountKey: string,
	sourceClientId: string | null,
): Promise<void> {
	void sourceClientId;
	return notImplemented(`pokeUser(${accountKey})`);
}
