/**
 * The pod's one Postgres LISTEN connection (ADR-0001, Realtime contract).
 *
 * - A dedicated connection outside the app pool (Bun SQL, max 1), counted in
 *   the pod's budget; it reads the password file like every connection.
 * - `SELECT 1` on it every 30 seconds; a timeout or error closes it and
 *   reconnects with backoff, so a half-open socket is noticed.
 * - After every (re)connect it emits a `resync` to all local subscribers,
 *   because NOTIFY is not durable and events sent while disconnected are lost.
 * - Keeps `realtime_listen_connected` and `realtime_last_notify_age_seconds`
 *   (src/server/metrics.server.ts) current.
 */
import { notImplemented } from "../not-implemented.server";
import type { RealtimeMessage } from "./notify.server";

export const PING_INTERVAL_MS = 30_000;

export interface Listener {
	/** Resolves once the first LISTEN is active. */
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Called for each decoded notification, and with `resync` after a reconnect. */
	onMessage(handler: (message: RealtimeMessage) => void): () => void;
}

export function createListener(channel: string): Listener {
	return notImplemented(`createListener(${channel})`);
}
