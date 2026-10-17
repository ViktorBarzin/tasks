import { describe, expect, test } from "bun:test";
import { parseMessage } from "@viktorbarzin/realtime/server";

import { parseTasksEvent } from "./realtime.server";

describe("tasks realtime events", () => {
	test("a NOTIFY payload carries the user key and a poke, nothing else", () => {
		expect(
			parseMessage(
				'{"to":"v","event":{"type":"poke","source_client_id":"tab-1"}}',
				parseTasksEvent,
			),
		).toEqual({
			to: "v",
			event: { type: "poke", source_client_id: "tab-1" },
		});
		expect(
			parseMessage('{"to":null,"event":{"type":"resync"}}', parseTasksEvent),
		).toEqual({ to: null, event: { type: "resync" } });
	});

	test("only the two tasks event shapes are accepted", () => {
		expect(parseTasksEvent({ type: "poke" })).toEqual({
			type: "poke",
			source_client_id: null,
		});
		expect(parseTasksEvent({ type: "invalidate", keys: [["x"]] })).toBeNull();
		expect(parseTasksEvent({ type: "drop_tables" })).toBeNull();
		expect(parseTasksEvent("poke")).toBeNull();
		expect(parseTasksEvent(null)).toBeNull();
	});

	test("a source client id is limited to 64 plain characters", () => {
		expect(
			parseTasksEvent({ type: "poke", source_client_id: "x".repeat(65) }),
		).toEqual({ type: "poke", source_client_id: null });
		expect(parseTasksEvent({ type: "poke", source_client_id: "a\nb" })).toEqual(
			{ type: "poke", source_client_id: null },
		);
	});
});
