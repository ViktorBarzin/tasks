/**
 * Realtime pokes over Server-Sent Events (ADR-0001, Pilot / Realtime).
 *
 * An op sent through tasks pokes the same user's other open devices, which
 * then run the existing sync cycle. The poke carries no data: the delta sync
 * (CalDAV sync-tokens behind the opaque cursor) is complete on its own, so a
 * lost poke only delays an update until the next trigger. That is why every
 * "events may have been lost" signal (a server `resync`, or this client
 * reconnecting) also just runs the sync cycle. Edits made in other CalDAV
 * clients still arrive on launch, focus and online, as before.
 *
 * Old Svelte builds never open this endpoint; it is not part of the frozen
 * contract.
 */
import { EVENTS_PATH, type RealtimeEvent } from "#/shared/contract";

/** The slice of EventSource this module drives (keeps it unit-testable). */
export interface EventSourceLike {
	readonly readyState: number;
	addEventListener(type: string, listener: (event: MessageEvent) => void): void;
	close(): void;
}

export interface RealtimeDeps {
	createSource(url: string): EventSourceLike;
	/** This tab's id (api.ts), to skip the poke its own ops caused. */
	clientId(): string;
	/** Another device changed something: run a delta sync. */
	onPoke(): void;
	/** Events may have been lost (resync event or reconnect): sync again. */
	onResync(): void;
}

export interface Realtime {
	/** Reopen at once if the browser gave up (after sign-in, online, focus). */
	reconnectNow(): void;
	/**
	 * Back in the foreground after `hiddenForMs`. Past RESUME_RECONNECT_MS the
	 * connection is reopened even if it looks open: iOS can leave a
	 * backgrounded standalone PWA's socket dead with readyState still OPEN,
	 * and the server's heartbeat is an SSE comment the page never sees.
	 */
	resume(hiddenForMs: number): void;
	stop(): void;
}

/** Hidden at least this long: reopen the stream on return (about the 25 s heartbeat). */
export const RESUME_RECONNECT_MS = 30_000;

/** EventSource.CLOSED: the browser will not retry by itself. */
const CLOSED = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

function sourceOf(event: MessageEvent): string | null {
	try {
		const parsed = JSON.parse(String(event.data)) as Partial<
			Extract<RealtimeEvent, { type: "poke" }>
		>;
		return typeof parsed.source_client_id === "string"
			? parsed.source_client_id
			: null;
	} catch {
		return null;
	}
}

export function startRealtime(deps: RealtimeDeps): Realtime {
	let source: EventSourceLike | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = 0;
	let stopped = false;

	function cancelRetry(): void {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
	}

	function scheduleReconnect(): void {
		retryDelay =
			retryDelay === 0
				? BACKOFF_BASE_MS
				: Math.min(retryDelay * 2, BACKOFF_CAP_MS);
		cancelRetry();
		retryTimer = setTimeout(() => {
			retryTimer = null;
			connect();
		}, retryDelay);
	}

	function connect(): void {
		if (stopped) return;
		cancelRetry();
		source?.close();
		const current = deps.createSource(EVENTS_PATH);
		source = current;
		current.addEventListener("open", () => {
			retryDelay = 0;
			// Covers the first connect too: a poke sent between launch's sync
			// and this subscription would otherwise be missed.
			deps.onResync();
		});
		current.addEventListener("poke", (event) => {
			if (sourceOf(event) !== deps.clientId()) deps.onPoke();
		});
		current.addEventListener("resync", () => deps.onResync());
		current.addEventListener("error", () => {
			// CONNECTING means the browser is already retrying (it honours the
			// server's `retry:` hint). CLOSED means it gave up, e.g. on a 401.
			if (current === source && current.readyState === CLOSED)
				scheduleReconnect();
		});
	}

	connect();

	function reconnectNow(): void {
		if (stopped || (source && source.readyState !== CLOSED)) return;
		retryDelay = 0;
		connect();
	}

	return {
		reconnectNow,
		resume(hiddenForMs) {
			if (stopped) return;
			if (hiddenForMs < RESUME_RECONNECT_MS) return reconnectNow();
			retryDelay = 0;
			connect();
		},
		stop() {
			stopped = true;
			cancelRetry();
			source?.close();
			source = null;
		},
	};
}

let live: Realtime | null = null;

/**
 * Open the app's realtime connection once (AppGate, on entering the app):
 * pokes and reconnects run the sync cycle; coming back online, to the
 * foreground or out of a sign-in reopens a connection the browser gave up on.
 */
export function startLiveUpdates(deps: {
	syncNow(): Promise<void>;
	clientId(): string;
	onSignedIn(listener: () => void): void;
}): void {
	if (live || typeof window === "undefined" || !("EventSource" in window))
		return;
	const current = startRealtime({
		createSource: (url) => new EventSource(url),
		clientId: deps.clientId,
		onPoke: () => void deps.syncNow(),
		onResync: () => void deps.syncNow(),
	});
	live = current;
	window.addEventListener("online", () => current.reconnectNow());
	let hiddenAt: number | null = null;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			hiddenAt = Date.now();
			return;
		}
		current.resume(hiddenAt === null ? 0 : Date.now() - hiddenAt);
		hiddenAt = null;
	});
	deps.onSignedIn(() => current.reconnectNow());
}
