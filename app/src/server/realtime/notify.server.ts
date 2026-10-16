/**
 * Sending realtime events (ADR-0001, Realtime). For `tasks` the event is a
 * poke: after POST /api/ops applies a batch, the same user's other open
 * devices are told to run a delta sync (Pilot / Realtime in the pilot).
 *
 * Events go through Postgres `pg_notify(channel, payload)` so every pod's
 * listener sees them. The NOTIFY queue is shared by every database on the
 * cluster and payloads are capped at 8000 bytes: a payload names the user and
 * nothing else, never task data.
 */
import type { RealtimeEvent } from "#/shared/contract";
import { getDb } from "../db/client.server";
import { getLogger } from "../logging.server";

const log = getLogger("tasks.realtime");

/** The LISTEN/NOTIFY channel this app uses. */
export const REALTIME_CHANNEL = "tasks_ops";

/** What travels in a NOTIFY payload (JSON). `account_key` routes it to that user's SSE streams. */
export interface RealtimeMessage {
	account_key: string | null;
	event: RealtimeEvent;
}

/** A client id is echoed back to its sender; keep it short and plain. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitizeClientId(
	raw: string | null | undefined,
): string | null {
	return raw && CLIENT_ID.test(raw) ? raw : null;
}

/** Parse a NOTIFY payload; null for anything that is not a RealtimeMessage. */
export function parseRealtimeMessage(payload: string): RealtimeMessage | null {
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { account_key: accountKey, event } = raw as Record<string, unknown>;
	if (accountKey !== null && typeof accountKey !== "string") return null;
	if (typeof event !== "object" || event === null) return null;
	const type = (event as { type?: unknown }).type;
	if (type === "resync")
		return { account_key: accountKey, event: { type: "resync" } };
	if (type === "poke") {
		const source = (event as { source_client_id?: unknown }).source_client_id;
		return {
			account_key: accountKey,
			event: {
				type: "poke",
				source_client_id:
					typeof source === "string" ? sanitizeClientId(source) : null,
			},
		};
	}
	return null;
}

export type NotifyFn = (channel: string, payload: string) => Promise<void>;

/** NOTIFY through the app pool (one short query, no extra connection). */
export const poolNotify: NotifyFn = async (channel, payload) => {
	await getDb().$client.notify(channel, payload);
};

/** pg_notify one message on REALTIME_CHANNEL using the app pool. */
export async function notify(
	message: RealtimeMessage,
	send: NotifyFn = poolNotify,
): Promise<void> {
	await send(REALTIME_CHANNEL, JSON.stringify(message));
}

/**
 * Tell every pod that `accountKey`'s data changed, so that user's open
 * devices run a delta sync. Never throws: a lost poke only delays a sync
 * until the next focus or reconnect, and must not fail the op batch.
 */
export async function publish(
	accountKey: string,
	sourceClientId: string | null = null,
	send: NotifyFn = poolNotify,
): Promise<void> {
	try {
		await notify(
			{
				account_key: accountKey,
				event: {
					type: "poke",
					source_client_id: sanitizeClientId(sourceClientId),
				},
			},
			send,
		);
	} catch (err) {
		log.warning("realtime poke not sent", { error: String(err) });
	}
}

/** The poke sent after an op batch applied at least one op. Same as `publish`. */
export async function pokeUser(
	accountKey: string,
	sourceClientId: string | null,
): Promise<void> {
	await publish(accountKey, sourceClientId);
}
