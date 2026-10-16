import { describe, expect, test } from "bun:test";

import { createSseHub, formatSseEvent } from "./hub.server";
import {
	parseRealtimeMessage,
	publish,
	sanitizeClientId,
} from "./notify.server";

async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	done: (text: string) => boolean,
	timeoutMs = 2_000,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (!done(text)) {
		const left = deadline - Date.now();
		if (left <= 0) throw new Error(`timed out; got ${JSON.stringify(text)}`);
		const next = await Promise.race([
			reader.read(),
			Bun.sleep(left).then(() => ({ done: true, value: undefined })),
		]);
		if (next.done) break;
		text += decoder.decode(next.value);
	}
	return text;
}

describe("SSE hub", () => {
	test("a stream opens with the SSE headers and a retry hint", async () => {
		const hub = createSseHub({ retryMs: 3000 });
		const controller = new AbortController();
		const res = hub.subscribe("viktor", controller.signal);
		expect(res.headers.get("content-type")).toStartWith("text/event-stream");
		expect(res.headers.get("cache-control")).toContain("no-cache");
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		expect(await readUntil(reader, (t) => t.includes("\n\n"))).toStartWith(
			"retry: 3000\n",
		);
		controller.abort();
	});

	test("pokes reach only the user's streams; resync reaches everyone", async () => {
		const hub = createSseHub();
		const a = new AbortController();
		const b = new AbortController();
		const viktor = (
			hub.subscribe("viktor", a.signal).body as ReadableStream<Uint8Array>
		).getReader();
		const anca = (
			hub.subscribe("anca", b.signal).body as ReadableStream<Uint8Array>
		).getReader();
		await readUntil(viktor, (t) => t.includes("connected"));
		await readUntil(anca, (t) => t.includes("connected"));

		hub.dispatch({
			account_key: "viktor",
			event: { type: "poke", source_client_id: "dev-1" },
		});
		hub.dispatch({ account_key: null, event: { type: "resync" } });
		const forViktor = await readUntil(viktor, (t) =>
			t.includes("event: resync"),
		);
		const forAnca = await readUntil(anca, (t) => t.includes("event: resync"));
		expect(forViktor).toContain(
			'event: poke\ndata: {"type":"poke","source_client_id":"dev-1"}\n\n',
		);
		expect(forAnca).not.toContain("poke");
		a.abort();
		b.abort();
	});

	test("a comment heartbeat is sent on the interval", async () => {
		const hub = createSseHub({ heartbeatMs: 50 });
		const controller = new AbortController();
		const reader = (
			hub.subscribe("viktor", controller.signal)
				.body as ReadableStream<Uint8Array>
		).getReader();
		const text = await readUntil(
			reader,
			(t) => (t.match(/: ping\n\n/g) ?? []).length >= 2,
		);
		expect(text).toContain(": ping\n\n");
		controller.abort();
	});

	test("aborting the request closes the stream and forgets it", async () => {
		const hub = createSseHub();
		const controller = new AbortController();
		const reader = (
			hub.subscribe("viktor", controller.signal)
				.body as ReadableStream<Uint8Array>
		).getReader();
		expect(hub.size()).toBe(1);
		controller.abort();
		expect(hub.size()).toBe(0);
		await readUntil(reader, () => false, 200).catch(() => "");
		const end = await reader.read();
		expect(end.done).toBe(true);
	});

	test("formatSseEvent", () => {
		expect(formatSseEvent({ type: "resync" })).toBe(
			'event: resync\ndata: {"type":"resync"}\n\n',
		);
	});
});

describe("notify payloads", () => {
	test("publish sends the user key and nothing else", async () => {
		const sent: Array<[string, string]> = [];
		await publish("viktor@example.com", "tab-1", async (channel, payload) => {
			sent.push([channel, payload]);
		});
		expect(sent).toEqual([
			[
				"tasks_ops",
				'{"account_key":"viktor@example.com","event":{"type":"poke","source_client_id":"tab-1"}}',
			],
		]);
	});

	test("publish never throws; a lost poke only delays a sync", async () => {
		await publish("viktor", null, async () => {
			throw new Error("database down");
		});
	});

	test("client ids are limited to 64 plain characters", () => {
		expect(sanitizeClientId("abc-DEF_123")).toBe("abc-DEF_123");
		expect(sanitizeClientId("x".repeat(65))).toBeNull();
		expect(sanitizeClientId("a\nb")).toBeNull();
		expect(sanitizeClientId(null)).toBeNull();
	});

	test("parseRealtimeMessage accepts only the two event shapes", () => {
		expect(
			parseRealtimeMessage(
				'{"account_key":"v","event":{"type":"poke","source_client_id":null}}',
			),
		).toEqual({
			account_key: "v",
			event: { type: "poke", source_client_id: null },
		});
		expect(
			parseRealtimeMessage('{"account_key":null,"event":{"type":"resync"}}'),
		).toEqual({
			account_key: null,
			event: { type: "resync" },
		});
		expect(parseRealtimeMessage('{"ping":"x"}')).toBeNull();
		expect(
			parseRealtimeMessage('{"account_key":1,"event":{"type":"poke"}}'),
		).toBeNull();
		expect(
			parseRealtimeMessage(
				'{"account_key":"v","event":{"type":"drop_tables"}}',
			),
		).toBeNull();
		expect(parseRealtimeMessage("not json")).toBeNull();
	});
});
