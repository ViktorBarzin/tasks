/**
 * Browser product events (tasks ADR-0005): the names and properties the
 * pipeline accepts, and the search hook that sends one event per search.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { renderHook } from "@testing-library/react";
import { checkEvent } from "@viktorbarzin/telemetry";

import {
	completedTasksToggled,
	searchStarted,
	setTrackForTests,
	smartViewOpened,
	taskSheetOpened,
	useSearchStarted,
} from "./events";

let sent: Array<[string, Record<string, unknown> | undefined]> = [];
const restore = setTrackForTests((name, properties) => {
	sent.push([name, properties]);
});

afterEach(() => {
	sent = [];
});
// Every test file shares one process: put the real sender back.
afterAll(() => restore());

describe("browser events", () => {
	it("send names and properties the pipeline accepts", () => {
		smartViewOpened("today");
		completedTasksToggled(true);
		searchStarted("home");
		taskSheetOpened("new");
		expect(sent).toEqual([
			["smart_view.opened", { view: "today" }],
			["completed_tasks.toggled", { shown: true }],
			["search.started", { screen: "home" }],
			["task_sheet.opened", { mode: "new" }],
		]);
		for (const [name, properties] of sent)
			expect(checkEvent(name, properties).problems).toEqual([]);
	});

	it("useSearchStarted sends once when a query starts, again after it is cleared", () => {
		const { rerender } = renderHook(
			({ query }) => useSearchStarted(query, "smart_view"),
			{ initialProps: { query: "" } },
		);
		rerender({ query: "m" });
		rerender({ query: "mi" });
		rerender({ query: "  " });
		rerender({ query: "b" });
		expect(sent).toEqual([
			["search.started", { screen: "smart_view" }],
			["search.started", { screen: "smart_view" }],
		]);
	});
});
