import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";

import { createTask, recentlyCompleted } from "#/client/actions";
import { todayKey } from "#/client/dates";
import { replica } from "#/client/replica";
import type { Priority, Task } from "#/client/types";
import { now as clock } from "#/client/ui/clock";
import { listColor } from "#/client/ui/listColors";
import { useStore } from "#/client/useStore";
import {
	buildAllView,
	buildScheduledView,
	buildTodayView,
	filterGroups,
	filterTasks,
	sortedLists,
	type TaskGroup,
	type ViewOptions,
} from "#/client/views";

import { CompletedBar } from "./CompletedBar";
import { QuickAdd } from "./QuickAdd";
import { Screen } from "./Screen";
import { TaskRow } from "./TaskRow";
import { TaskSheet } from "./TaskSheet";

type ViewName = "today" | "scheduled" | "all";
const VIEWS: Record<ViewName, { title: string; color: string; empty: string }> =
	{
		today: { title: "Today", color: "#007aff", empty: "Nothing due today." },
		scheduled: {
			title: "Scheduled",
			color: "#ff3b30",
			empty: "Nothing scheduled.",
		},
		all: { title: "All", color: "#8e8e93", empty: "No open Tasks." },
	};

function isViewName(value: string): value is ViewName {
	return Object.hasOwn(VIEWS, value);
}

/**
 * The three Smart Views (CONTEXT.md): Today (due or overdue, flat),
 * Scheduled (has a Due, grouped by day), All (open Tasks grouped by List).
 * Pure derivations over the Replica; quick-add lands in the first List, with
 * a due of today where that keeps the new Task visible in the view.
 */
export function SmartViewPage({ view: viewParam }: { view: string }) {
	const navigate = useNavigate();
	const view = isViewName(viewParam) ? viewParam : null;
	const cfg = view ? VIEWS[view] : null;

	useEffect(() => {
		if (!view) void navigate({ to: "/", replace: true });
	}, [view, navigate]);

	const state = useStore(replica);
	const now = useStore(clock);
	const grace = useStore(recentlyCompleted);

	const [query, setQuery] = useState("");
	const [showCompleted, setShowCompleted] = useState(false);
	const [sheetTask, setSheetTask] = useState<Task | null>(null);
	const [draftTitle, setDraftTitle] = useState("");
	const [draftPriority, setDraftPriority] = useState<Priority>(0);
	const [createOpen, setCreateOpen] = useState(false);

	function clearDraft(): void {
		setDraftTitle("");
		setDraftPriority(0);
	}

	const lists = useMemo(() => sortedLists(state), [state]);
	const opts = useMemo<ViewOptions>(
		() => ({ showCompleted, now, grace }),
		[showCompleted, now, grace],
	);

	/** Today renders flat; Scheduled/All render grouped. */
	const rows = useMemo<Task[]>(
		() =>
			view === "today" ? filterTasks(buildTodayView(state, opts), query) : [],
		[view, state, opts, query],
	);
	const groups = useMemo<TaskGroup[]>(
		() =>
			view === "scheduled"
				? filterGroups(buildScheduledView(state, opts), query)
				: view === "all"
					? filterGroups(buildAllView(state, opts), query)
					: [],
		[view, state, opts, query],
	);
	const isEmpty = view === "today" ? rows.length === 0 : groups.length === 0;

	const completedCount = useMemo(() => {
		if (!view) return 0;
		const withDone: ViewOptions = { showCompleted: true, now };
		const tasks =
			view === "today"
				? buildTodayView(state, withDone)
				: view === "scheduled"
					? buildScheduledView(state, withDone).flatMap((g) => g.tasks)
					: buildAllView(state, withDone).flatMap((g) => g.tasks);
		return tasks.filter((t) => t.completed).length;
	}, [view, state, now]);

	function listName(t: Task): string {
		return state.lists.get(t.list_id)?.name ?? "";
	}

	/** Quick-add: first List; Today/Scheduled default the Due to today so the
	 * new Task stays visible in the view it was typed into. */
	async function quickAdd(fields: {
		title: string;
		priority: Priority;
	}): Promise<void> {
		const listId = lists[0]?.id;
		if (!listId) return;
		await createTask(
			listId,
			view === "all" ? fields : { ...fields, due: todayKey() },
		);
	}

	if (!view || !cfg) return null;

	return (
		<>
			<Screen
				title={cfg.title}
				tint={cfg.color}
				back={{ href: "/", label: "Lists" }}
				bottom={
					lists.length > 0 && (
						<QuickAdd
							text={draftTitle}
							onTextChange={setDraftTitle}
							priority={draftPriority}
							onPriorityChange={setDraftPriority}
							onAdd={quickAdd}
							onExpand={() => setCreateOpen(true)}
						/>
					)
				}
			>
				<input
					className="search"
					type="search"
					placeholder="Search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					autoComplete="off"
					aria-label={`Search in ${cfg.title}`}
				/>

				<CompletedBar
					count={completedCount}
					shown={showCompleted}
					onToggle={() => setShowCompleted((on) => !on)}
				/>

				{isEmpty ? (
					<p className="empty">
						{query.trim() ? `No results for “${query.trim()}”` : cfg.empty}
					</p>
				) : view === "today" ? (
					<div className="card hairline-rows">
						{rows.map((t) => (
							<TaskRow
								key={t.uid}
								task={t}
								now={now}
								tint={listColor(t.list_id)}
								caption={listName(t)}
								onOpen={() => setSheetTask(t)}
							/>
						))}
					</div>
				) : (
					groups.map((g) => (
						<Fragment key={g.key}>
							<h2
								className={
									view === "scheduled" && g.key < todayKey(now)
										? "eyebrow group-heading overdue"
										: "eyebrow group-heading"
								}
							>
								{g.heading}
							</h2>
							<div className="card hairline-rows">
								{g.tasks.map((t) => (
									<TaskRow
										key={t.uid}
										task={t}
										now={now}
										tint={listColor(t.list_id)}
										caption={view === "scheduled" ? listName(t) : undefined}
										onOpen={() => setSheetTask(t)}
									/>
								))}
							</div>
						</Fragment>
					))
				)}
			</Screen>

			<TaskSheet
				open={sheetTask !== null}
				task={sheetTask}
				onClose={() => setSheetTask(null)}
			/>

			{/* Expanded quick-add: create sheet prefilled with the draft;
			    Today/Scheduled seed the due so the new Task stays visible. */}
			<TaskSheet
				open={createOpen}
				defaultListId={lists[0]?.id ?? ""}
				defaultDue={view === "all" ? null : todayKey()}
				defaultTitle={draftTitle}
				defaultPriority={draftPriority}
				onSaved={clearDraft}
				onClose={() => setCreateOpen(false)}
			/>
		</>
	);
}
