import { afterEach, describe, expect, it, mock } from "bun:test";

import { EVENTS_PATH } from "#/shared/contract";

import { type EventSourceLike, startRealtime } from "./realtime";
import { type FakeTimeouts, fakeTimeouts } from "./test-timers";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeSource implements EventSourceLike {
	readyState = CONNECTING;
	closed = false;
	private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
	constructor(readonly url: string) {}
	addEventListener(type: string, fn: (e: MessageEvent) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(fn);
		this.listeners.set(type, set);
	}
	close(): void {
		this.closed = true;
		this.readyState = CLOSED;
	}
	emit(type: string, data?: unknown): void {
		if (type === "open") this.readyState = OPEN;
		const event = new MessageEvent(type, {
			data: data === undefined ? "" : JSON.stringify(data),
		});
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** The browser gave up (a non-200 answer such as a 401): no auto-retry. */
	fail(): void {
		this.readyState = CLOSED;
		this.emit("error");
	}
	/** A dropped connection the browser retries by itself. */
	drop(): void {
		this.readyState = CONNECTING;
		this.emit("error");
	}
}

let timers: FakeTimeouts | null = null;
afterEach(() => {
	timers?.restore();
	timers = null;
});

function harness() {
	const sources: FakeSource[] = [];
	const onPoke = mock(() => {});
	const onResync = mock(() => {});
	const rt = startRealtime({
		createSource: (url) => {
			const s = new FakeSource(url);
			sources.push(s);
			return s;
		},
		clientId: () => "me",
		onPoke,
		onResync,
	});
	const last = () => sources[sources.length - 1] as FakeSource;
	return { rt, sources, last, onPoke, onResync };
}

describe("realtime: SSE pokes drive delta syncs (ADR-0001, Pilot / Realtime)", () => {
	it("subscribes to the events endpoint", () => {
		const { sources } = harness();
		expect(sources.map((s) => s.url)).toEqual([EVENTS_PATH]);
	});

	it("runs a delta sync on another device's poke", () => {
		const { last, onPoke } = harness();
		last().emit("open");
		last().emit("poke", { type: "poke", source_client_id: "phone" });
		expect(onPoke).toHaveBeenCalledTimes(1);
	});

	it("ignores the poke its own ops caused", () => {
		const { last, onPoke } = harness();
		last().emit("open");
		last().emit("poke", { type: "poke", source_client_id: "me" });
		expect(onPoke).not.toHaveBeenCalled();
	});

	it("treats a poke without a source as someone else's", () => {
		const { last, onPoke } = harness();
		last().emit("poke", { type: "poke", source_client_id: null });
		last().emit("poke");
		expect(onPoke).toHaveBeenCalledTimes(2);
	});

	it("resyncs on a server `resync` (its LISTEN connection reconnected)", () => {
		const { last, onResync } = harness();
		last().emit("open");
		onResync.mockClear();
		last().emit("resync", { type: "resync" });
		expect(onResync).toHaveBeenCalledTimes(1);
	});

	it("resyncs after every reconnect, since pokes sent meanwhile are lost", () => {
		const { last, onResync } = harness();
		last().emit("open");
		const afterFirst = onResync.mock.calls.length;
		last().drop();
		last().emit("open");
		expect(onResync.mock.calls.length).toBe(afterFirst + 1);
	});

	it("reconnects by itself, with backoff, when the browser gives up (e.g. a 401)", async () => {
		timers = fakeTimeouts();
		const { sources, last } = harness();
		last().fail();
		expect(sources).toHaveLength(1);
		await timers.advance(1000);
		expect(sources).toHaveLength(2);
		last().fail();
		await timers.advance(1999);
		expect(sources).toHaveLength(2);
		await timers.advance(1);
		expect(sources).toHaveLength(3);
	});

	it("leaves a dropped connection to the browser's own retry", async () => {
		timers = fakeTimeouts();
		const { sources, last } = harness();
		last().emit("open");
		last().drop();
		await timers.advance(120_000);
		expect(sources).toHaveLength(1);
	});

	it("reconnectNow reopens a given-up connection at once (after sign-in, online, focus)", () => {
		timers = fakeTimeouts();
		const { rt, sources, last } = harness();
		last().fail();
		rt.reconnectNow();
		expect(sources).toHaveLength(2);
		// A live connection is left alone.
		last().emit("open");
		rt.reconnectNow();
		expect(sources).toHaveLength(2);
	});

	it("stop closes the connection and cancels any pending reconnect", async () => {
		timers = fakeTimeouts();
		const { rt, sources, last } = harness();
		last().fail();
		rt.stop();
		await timers.advance(120_000);
		expect(sources).toHaveLength(1);
		expect(sources[0]?.closed).toBe(true);
	});
});
