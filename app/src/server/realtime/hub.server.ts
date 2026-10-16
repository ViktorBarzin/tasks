/**
 * The SSE hub: fans listener messages out to this pod's open GET /api/events
 * streams (ADR-0001, Realtime contract).
 *
 * - One stream per open tab or device, keyed by the user's account key.
 * - `: ping` comment heartbeat every 25 seconds (Cloudflare closes idle
 *   responses after about 100 seconds), a `retry:` hint on open, and
 *   `Cache-Control: no-cache`, `Content-Type: text/event-stream`.
 * - A `resync` message with a null account key goes to every stream.
 * - The route applies the CSRF origin check before calling `subscribe`.
 * - Apps using this hub stay out of Sablier scale-to-zero for now.
 */
import type { RealtimeEvent } from "#/shared/contract";
import { notImplemented } from "../not-implemented.server";
import type { RealtimeMessage } from "./notify.server";

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const RETRY_HINT_MS = 3_000;

/** Format one SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function formatSseEvent(event: RealtimeEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface SseHub {
	/** A streaming Response for one subscriber; closes when `signal` aborts. */
	subscribe(accountKey: string, signal: AbortSignal): Response;
	/** Deliver a listener message to the matching local streams. */
	dispatch(message: RealtimeMessage): void;
	/** Open streams on this pod. */
	size(): number;
}

export function createSseHub(): SseHub {
	return notImplemented("createSseHub");
}

/** The process-wide hub, wired to the listener on first use. */
export function getSseHub(): SseHub {
	return notImplemented("getSseHub");
}
