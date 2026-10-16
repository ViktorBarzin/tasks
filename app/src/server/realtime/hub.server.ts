/**
 * The SSE hub: fans listener messages out to this pod's open GET /api/events
 * streams (ADR-0001, Realtime contract).
 *
 * - One stream per open tab or device, keyed by the user's account key.
 * - `: ping` comment heartbeat every 25 seconds (Cloudflare closes idle
 *   responses after about 100 seconds), a `retry:` hint on open, and
 *   `Cache-Control: no-cache`, `Content-Type: text/event-stream`.
 * - A `resync` message with a null account key goes to every stream.
 * - The CSRF middleware (src/start.ts) checks the origin before the route
 *   calls `subscribe`.
 * - Apps using this hub stay out of Sablier scale-to-zero for now.
 */
import type { RealtimeEvent } from "#/shared/contract";
import { getLogger } from "../logging.server";
import { processSingleton } from "../singleton.server";
import { createListener, type Listener } from "./listener.server";
import { REALTIME_CHANNEL, type RealtimeMessage } from "./notify.server";

const log = getLogger("tasks.realtime");

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const RETRY_HINT_MS = 3_000;

/** Format one SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function formatSseEvent(event: RealtimeEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
	// Tell nginx-style proxies not to buffer the stream.
	"x-accel-buffering": "no",
} as const;

interface BunRuntimeRequest {
	runtime?: {
		bun?: { server?: { timeout?(request: Request, seconds: number): void } };
	};
}

/**
 * Bun closes a connection after 10 idle seconds by default, which would cut
 * an SSE stream between 25-second heartbeats. Lift the limit for this one
 * request (Bun's `server.timeout(request, 0)`, reached through srvx's
 * `request.runtime.bun.server`). Returns false when not running on Bun.
 */
export function keepRequestOpen(request: Request): boolean {
	const server = (request as BunRuntimeRequest).runtime?.bun?.server;
	if (typeof server?.timeout !== "function") return false;
	server.timeout(request, 0);
	return true;
}

export interface SseHub {
	/** A streaming Response for one subscriber; closes when `signal` aborts. */
	subscribe(accountKey: string, signal: AbortSignal): Response;
	/** Deliver a listener message to the matching local streams. */
	dispatch(message: RealtimeMessage): void;
	/** Open streams on this pod. */
	size(): number;
	/** Close every stream (shutdown, tests). */
	closeAll(): void;
}

export interface SseHubOptions {
	heartbeatMs?: number;
	retryMs?: number;
}

interface Stream {
	accountKey: string;
	send(chunk: string): void;
	close(): void;
}

export function createSseHub(options: SseHubOptions = {}): SseHub {
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
	const retryMs = options.retryMs ?? RETRY_HINT_MS;
	const streams = new Set<Stream>();
	const encoder = new TextEncoder();

	return {
		subscribe(accountKey, signal) {
			let stream: Stream | null = null;
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			const cleanup = () => {
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = null;
				if (stream) streams.delete(stream);
				signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => stream?.close();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					let open = true;
					stream = {
						accountKey,
						send(chunk) {
							if (!open) return;
							try {
								controller.enqueue(encoder.encode(chunk));
							} catch {
								this.close();
							}
						},
						close() {
							if (!open) return;
							open = false;
							cleanup();
							try {
								controller.close();
							} catch {
								// already closed by the client going away
							}
						},
					};
					streams.add(stream);
					// The retry hint, and a first byte so proxies flush the headers.
					stream.send(`retry: ${retryMs}\n: connected\n\n`);
					heartbeat = setInterval(
						() => stream?.send(": ping\n\n"),
						heartbeatMs,
					);
					if (signal.aborted) stream.close();
					else signal.addEventListener("abort", onAbort, { once: true });
				},
				cancel() {
					stream?.close();
				},
			});
			return new Response(body, { headers: SSE_HEADERS });
		},
		dispatch(message) {
			const frame = formatSseEvent(message.event);
			for (const stream of streams) {
				if (
					message.account_key === null ||
					message.account_key === stream.accountKey
				) {
					stream.send(frame);
				}
			}
		},
		size() {
			return streams.size;
		},
		closeAll() {
			for (const stream of [...streams]) stream.close();
		},
	};
}

/** The hub and its listener, once per process (src/server/singleton.server.ts). */
const realtime = processSingleton("realtime.hub", () => ({
	shared: null as { hub: SseHub; listener: Listener } | null,
}));

/** The process-wide hub, wired to the listener on first use. */
export function getSseHub(): SseHub {
	if (realtime.shared === null) {
		const hub = createSseHub();
		const listener = createListener(REALTIME_CHANNEL);
		listener.onMessage((message) => hub.dispatch(message));
		listener
			.start()
			.catch((err) => log.exception("realtime listener failed to start", err));
		realtime.shared = { hub, listener };
	}
	return realtime.shared.hub;
}

/** Stop the listener and close every stream (graceful shutdown, tests). */
export async function stopSseHub(): Promise<void> {
	if (realtime.shared === null) return;
	const { hub, listener } = realtime.shared;
	realtime.shared = null;
	hub.closeAll();
	await listener.stop();
}
