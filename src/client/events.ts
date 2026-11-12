/**
 * Browser product events (tasks ADR-0005): actions only the page sees, since
 * every screen renders from the IndexedDB Replica and the server never hears
 * of them. Anything that becomes an op is a server event instead
 * (src/server/product-events.server.ts). Off the production hosts
 * `@viktorbarzin/telemetry/browser` sends nothing.
 */
import type { EventProperties } from "@viktorbarzin/telemetry";
import { track } from "@viktorbarzin/telemetry/browser";
import { useEffect, useRef } from "react";

type Send = (name: string, properties?: EventProperties) => void;

let send: Send = track;

/** Swap the sender; returns a function that puts the previous one back. */
export function setTrackForTests(fn: Send): () => void {
	const previous = send;
	send = fn;
	return () => {
		send = previous;
	};
}

/** A Smart View (today, scheduled, all) was opened. */
export function smartViewOpened(view: string): void {
	send("smart_view.opened", { view });
}

/** The completed section was shown or hidden. */
export function completedTasksToggled(shown: boolean): void {
	send("completed_tasks.toggled", { shown });
}

/** A search over the Replica began on a screen. */
export function searchStarted(screen: "home" | "smart_view"): void {
	send("search.started", { screen });
}

/** The task sheet opened, on a task ("edit") or for a new one ("new"). */
export function taskSheetOpened(mode: "edit" | "new"): void {
	send("task_sheet.opened", { mode });
}

/** One search.started each time the query goes from blank to non-blank. */
export function useSearchStarted(
	query: string,
	screen: "home" | "smart_view",
): void {
	const searching = useRef(false);
	const active = query.trim() !== "";
	useEffect(() => {
		if (active && !searching.current) searchStarted(screen);
		searching.current = active;
	}, [active, screen]);
}
