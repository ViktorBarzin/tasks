/**
 * The pod's one Postgres LISTEN connection (ADR-0001, Realtime contract).
 *
 * - Bun SQL's `listen()` keeps one dedicated connection outside the app pool;
 *   it reads the password file like every connection.
 * - Every 30 seconds the listener checks that connection: it sends a ping
 *   NOTIFY through the app pool and waits for it to come back on the LISTEN
 *   connection. Bun's `listen()` exposes no way to run `SELECT 1` on its
 *   dedicated connection, so the round trip through LISTEN itself is the
 *   check; it also notices a LISTEN that silently stopped. A ping that does
 *   not return within PING_TIMEOUT_MS closes the connection and opens a new
 *   one, with backoff, so a half-open socket is noticed.
 * - After every reconnect (Bun's own after a drop, or ours) it emits a
 *   `resync` to all local subscribers, because NOTIFY is not durable and
 *   events sent while disconnected are lost.
 * - Keeps `realtime_listen_connected` and `realtime_last_notify_age_seconds`
 *   current. Pings count as notifications, so the age stays under about 30
 *   seconds while the path works and grows when it does not.
 */
import type { SQL } from "bun";

import { createSqlClient } from "../db/client.server";
import { getLogger } from "../logging.server";
import {
	realtimeLastNotifyAgeSeconds,
	realtimeListenConnected,
} from "../metrics.server";
import {
	type NotifyFn,
	parseRealtimeMessage,
	poolNotify,
	type RealtimeMessage,
} from "./notify.server";

const log = getLogger("tasks.realtime");

export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 10_000;
const AGE_UPDATE_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

export interface Listener {
	/** Resolves once the first LISTEN is active. */
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Called for each decoded notification, and with `resync` after a reconnect. */
	onMessage(handler: (message: RealtimeMessage) => void): () => void;
}

export interface ListenerOptions {
	/** A client for the LISTEN connection. Default: a fresh Bun SQL client, max 1. */
	createClient?: () => SQL;
	/** Sends the ping NOTIFY. Default: the app pool. */
	notify?: NotifyFn;
	pingIntervalMs?: number;
	pingTimeoutMs?: number;
	/** Delay before reconnect attempt `n` (1-based). */
	backoffMs?: (attempt: number) => number;
}

const RESYNC: RealtimeMessage = {
	account_key: null,
	event: { type: "resync" },
};

function defaultBackoff(attempt: number): number {
	return Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
}

export function createListener(
	channel: string,
	options: ListenerOptions = {},
): Listener {
	const createClient =
		options.createClient ?? (() => createSqlClient({ max: 1, idleTimeout: 0 }));
	const sendNotify = options.notify ?? poolNotify;
	const pingInterval = options.pingIntervalMs ?? PING_INTERVAL_MS;
	const pingTimeout = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
	const backoff = options.backoffMs ?? defaultBackoff;
	const instance = crypto.randomUUID();

	const handlers = new Set<(message: RealtimeMessage) => void>();
	let client: SQL | null = null;
	let stopped = true;
	let listenedOnce = false;
	let lastNotifyAt = Date.now();
	let pingSeq = 0;
	let waitingPing: { id: string; resolve: () => void } | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let ageTimer: ReturnType<typeof setInterval> | null = null;
	let reconnecting: Promise<void> | null = null;
	let firstListen: { promise: Promise<void>; resolve: () => void };

	function newFirstListen() {
		let resolve = () => {};
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		firstListen = { promise, resolve };
	}
	newFirstListen();

	function emit(message: RealtimeMessage) {
		for (const handler of handlers) {
			try {
				handler(message);
			} catch (err) {
				log.exception("realtime handler failed", err);
			}
		}
	}

	function updateAge() {
		realtimeLastNotifyAgeSeconds.set((Date.now() - lastNotifyAt) / 1000);
	}

	function onPayload(payload: string) {
		lastNotifyAt = Date.now();
		updateAge();
		let ping: unknown;
		try {
			ping = (JSON.parse(payload) as { ping?: unknown }).ping;
		} catch {
			ping = undefined;
		}
		if (typeof ping === "string") {
			if (waitingPing?.id === ping) waitingPing.resolve();
			return;
		}
		const message = parseRealtimeMessage(payload);
		if (message) emit(message);
		else log.debug("ignored a NOTIFY payload that is not a realtime message");
	}

	function onListen() {
		realtimeListenConnected.set(1);
		if (listenedOnce) {
			log.info("LISTEN re-established; asking clients to resync", { channel });
			emit(RESYNC);
		}
		listenedOnce = true;
		firstListen.resolve();
	}

	async function closeClient() {
		const old = client;
		client = null;
		if (old) await old.close({ timeout: 0 }).catch(() => {});
	}

	async function connect(): Promise<void> {
		let attempt = 0;
		while (!stopped) {
			const next = createClient();
			try {
				client = next;
				await next.listen(channel, onPayload, onListen);
				return;
			} catch (err) {
				attempt += 1;
				realtimeListenConnected.set(0);
				if (client === next) await closeClient();
				const delay = backoff(attempt);
				log.warning("LISTEN failed; retrying", {
					channel,
					attempt,
					delay_ms: delay,
					error: String(err),
				});
				await Bun.sleep(delay);
			}
		}
	}

	function reconnect(reason: string): Promise<void> {
		if (reconnecting) return reconnecting;
		reconnecting = (async () => {
			realtimeListenConnected.set(0);
			log.warning("LISTEN connection looks dead; reconnecting", {
				channel,
				reason,
			});
			await closeClient();
			await connect();
		})().finally(() => {
			reconnecting = null;
		});
		return reconnecting;
	}

	/** One heartbeat: a ping NOTIFY must come back on the LISTEN connection. */
	async function ping(): Promise<void> {
		if (stopped || reconnecting || !client) return;
		pingSeq += 1;
		const id = `${instance}:${pingSeq}`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const arrived = new Promise<boolean>((resolve) => {
			waitingPing = { id, resolve: () => resolve(true) };
			timer = setTimeout(() => resolve(false), pingTimeout);
		});
		try {
			await sendNotify(channel, JSON.stringify({ ping: id }));
		} catch (err) {
			// The pool could not send; that says nothing about the LISTEN side.
			log.warning("realtime ping not sent", { error: String(err) });
			clearTimeout(timer);
			waitingPing = null;
			return;
		}
		const ok = await arrived;
		clearTimeout(timer);
		waitingPing = null;
		if (!ok && !stopped) await reconnect("ping timed out");
	}

	return {
		async start() {
			if (!stopped) return firstListen.promise;
			stopped = false;
			lastNotifyAt = Date.now();
			realtimeListenConnected.set(0);
			updateAge();
			pingTimer = setInterval(() => void ping(), pingInterval);
			ageTimer = setInterval(updateAge, AGE_UPDATE_MS);
			pingTimer.unref?.();
			ageTimer.unref?.();
			void connect();
			return firstListen.promise;
		},
		async stop() {
			stopped = true;
			if (pingTimer) clearInterval(pingTimer);
			if (ageTimer) clearInterval(ageTimer);
			pingTimer = null;
			ageTimer = null;
			waitingPing?.resolve();
			await closeClient();
			realtimeListenConnected.set(0);
			listenedOnce = false;
			newFirstListen();
		},
		onMessage(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
	};
}
