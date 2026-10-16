import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useMemo, useState } from "react";

import { createList, reorderLists } from "#/client/actions";
import { replica, replicaLoaded } from "#/client/replica";
import type { Task, TaskList } from "#/client/types";
import { now as clock } from "#/client/ui/clock";
import { applyReorder, dragReorder } from "#/client/ui/dragReorder";
import { listColor } from "#/client/ui/listColors";
import { useStore } from "#/client/useStore";
import {
	planListReorder,
	searchTasks,
	sortedLists,
	viewCounts,
} from "#/client/views";

import { AlertPrompt } from "./AlertPrompt";
import { Icon } from "./Icon";
import { Screen } from "./Screen";
import { TaskRow } from "./TaskRow";
import { TaskSheet } from "./TaskSheet";
import { useAction } from "./useAction";

const ICON_TODAY =
	"M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";
const ICON_SCHEDULED =
	"M8 3v4M16 3v4M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z";
const ICON_ALL = "M4 6h16M4 12h16M4 18h10";
const ICON_LIST = "M8 7h9M8 12h9M8 17h9M4.5 7h.01M4.5 12h.01M4.5 17h.01";

/**
 * Home: search, Smart View tiles (Today / Scheduled / All with counts), My
 * Lists with open counts (long-press a row, or press-and-drag with a mouse,
 * to reorder; Edit → drag handles, both server-backed via list_reorder ops),
 * New Task + Add List in the bottom bar.
 *
 * NOTHING on Home is an <a>: iOS owns long-press on links (Safari link
 * preview / context menu), which both looks wrong in a standalone PWA and
 * steals the long-press-to-reorder gesture. Tiles and rows are role="link"
 * elements navigating in code, with touch-callout/user-select off statically:
 * iOS decides the gesture BEFORE any JS runs.
 */
export function HomePage() {
	const navigate = useNavigate();
	const state = useStore(replica);
	const loaded = useStore(replicaLoaded);
	const now = useStore(clock);

	const [query, setQuery] = useState("");
	const [addListOpen, setAddListOpen] = useState(false);
	const [newTaskOpen, setNewTaskOpen] = useState(false);
	const [sheetTask, setSheetTask] = useState<Task | null>(null);

	const lists = useMemo(() => sortedLists(state), [state]);
	const counts = useMemo(() => viewCounts(state, now), [state, now]);
	const hits = useMemo(() => searchTasks(state, query), [state, query]);

	// Reordering (contract v1.2 §2), two entry points: long-press-to-lift on
	// any row (liftOnHold) and the Edit-mode drag handles (immediate grab).
	// The dragReorder action owns the gesture and reports the drop as
	// (from, to); the commit emits one list_reorder op per changed List and
	// `pendingOrder` bridges the ms until the optimistic fold re-sorts the store.
	// Pull-to-refresh is off in Edit mode so an at-the-top downward drag can
	// never be taken as a refresh pull.
	const [editMode, setEditMode] = useState(false);
	const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

	const displayLists = useMemo((): TaskList[] => {
		if (!pendingOrder) return lists;
		const byId = new Map(lists.map((l) => [l.id, l]));
		return pendingOrder
			.map((id) => byId.get(id))
			.filter((l): l is TaskList => l !== undefined);
	}, [lists, pendingOrder]);

	async function commitReorder(ids: string[]): Promise<void> {
		try {
			await reorderLists(planListReorder(lists, ids));
		} finally {
			setPendingOrder(null);
		}
	}

	/** Drop from the dragReorder action. It runs inside flushSync, so setting
	 * `pendingOrder` re-renders the rows before the action's transform reset. */
	function onreorder(from: number, to: number): void {
		const ids = applyReorder(
			displayLists.map((l) => l.id),
			from,
			to,
		);
		setPendingOrder(ids);
		void commitReorder(ids);
	}

	const listContainer = useAction(dragReorder, {
		enabled: true,
		liftOnHold: true,
		onreorder,
	});

	const tiles = [
		{
			href: "/view/today",
			label: "Today",
			color: "#007aff",
			icon: ICON_TODAY,
			count: counts.today,
		},
		{
			href: "/view/scheduled",
			label: "Scheduled",
			color: "#ff3b30",
			icon: ICON_SCHEDULED,
			count: counts.scheduled,
		},
		{
			href: "/view/all",
			label: "All",
			color: "#8e8e93",
			icon: ICON_ALL,
			count: counts.all,
		},
	];

	function go(href: string): void {
		void navigate({ to: href });
	}

	async function addList(name: string): Promise<void> {
		setAddListOpen(false);
		const id = await createList(name);
		await navigate({ to: "/list/$id", params: { id } });
	}

	/** Keyboard activation for the role="link" tiles/rows (Enter, like an <a>). */
	function linkKeydown(e: KeyboardEvent, href: string): void {
		if (e.key !== "Enter") return;
		e.preventDefault();
		go(href);
	}

	return (
		<>
			<Screen
				title="Tasks"
				refreshDisabled={editMode}
				right={
					lists.length > 1 &&
					!query.trim() && (
						<button
							type="button"
							className={editMode ? "edit-btn strong" : "edit-btn"}
							onClick={() => setEditMode((on) => !on)}
						>
							{editMode ? "Done" : "Edit"}
						</button>
					)
				}
				bottom={
					<>
						<button
							type="button"
							className="new-task"
							onClick={() => setNewTaskOpen(true)}
							disabled={lists.length === 0}
						>
							<svg
								width="22"
								height="22"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.4"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<circle
									cx="12"
									cy="12"
									r="9"
									fill="currentColor"
									stroke="none"
								/>
								<path d="M12 8.5v7M8.5 12h7" stroke="var(--ios-bg)" />
							</svg>
							New Task
						</button>
						<button
							type="button"
							className="add-list"
							onClick={() => setAddListOpen(true)}
						>
							Add List
						</button>
					</>
				}
			>
				<input
					className="search"
					type="search"
					placeholder="Search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					autoComplete="off"
					aria-label="Search tasks"
				/>

				{query.trim() ? (
					<div className="card hairline-rows results">
						{hits.length === 0 ? (
							<p className="empty">No results for “{query.trim()}”</p>
						) : (
							hits.map((hit) => (
								<TaskRow
									key={hit.task.uid}
									task={hit.task}
									now={now}
									tint={listColor(hit.task.list_id)}
									caption={hit.listName}
									onOpen={() => setSheetTask(hit.task)}
								/>
							))
						)}
					</div>
				) : (
					<>
						<div className="tiles">
							{tiles.map((tile) => (
								<div
									key={tile.href}
									className="tile card"
									role="link"
									tabIndex={0}
									onClick={() => go(tile.href)}
									onKeyDown={(e) => linkKeydown(e, tile.href)}
								>
									<span className="tile-top">
										<span
											className="tile-icon"
											style={{ background: tile.color }}
										>
											<Icon path={tile.icon} size={16} stroke={2.2} />
										</span>
										<span className="tile-count">{tile.count}</span>
									</span>
									<span className="tile-label">{tile.label}</span>
								</div>
							))}
						</div>

						<h2 className="eyebrow section-heading">My Lists</h2>
						<div className="card hairline-rows" ref={listContainer}>
							{displayLists.length === 0 ? (
								<p className="empty">
									{loaded ? "No Lists yet — add one below." : "Loading…"}
								</p>
							) : (
								displayLists.map((l) => {
									const draggable = displayLists.length > 1 ? " draggable" : "";
									return editMode ? (
										<div
											key={l.id}
											className={`list-row${draggable}`}
											data-drag-item
										>
											<span
												className="list-dot"
												style={{ background: listColor(l.id) }}
											>
												<Icon path={ICON_LIST} size={15} stroke={2} />
											</span>
											<span className="list-name">{l.name}</span>
											<button
												type="button"
												className="drag-handle"
												data-drag-handle
												aria-label={`Reorder ${l.name}`}
											>
												<svg
													width="20"
													height="20"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="1.8"
													strokeLinecap="round"
													aria-hidden="true"
												>
													<path d="M4 8h16M4 16h16" />
												</svg>
											</button>
										</div>
									) : (
										<div
											key={l.id}
											className={`list-row nav${draggable}`}
											data-drag-item
											role="link"
											tabIndex={0}
											onClick={() => go(`/list/${l.id}`)}
											onKeyDown={(e) => linkKeydown(e, `/list/${l.id}`)}
										>
											<span
												className="list-dot"
												style={{ background: listColor(l.id) }}
											>
												<Icon path={ICON_LIST} size={15} stroke={2} />
											</span>
											<span className="list-name">{l.name}</span>
											<span className="list-count">
												{counts.byList.get(l.id) ?? 0}
											</span>
											<svg
												className="chevron"
												width="8"
												height="14"
												viewBox="0 0 8 14"
												fill="none"
												aria-hidden="true"
											>
												<path
													d="m1.5 1.5 5 5.5-5 5.5"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										</div>
									);
								})
							)}
						</div>
					</>
				)}
			</Screen>

			<TaskSheet
				open={newTaskOpen}
				defaultListId={lists[0]?.id ?? ""}
				onClose={() => setNewTaskOpen(false)}
			/>
			<TaskSheet
				open={sheetTask !== null}
				task={sheetTask}
				onClose={() => setSheetTask(null)}
			/>
			<AlertPrompt
				open={addListOpen}
				title="New List"
				withInput
				placeholder="List name"
				confirmLabel="Create"
				onConfirm={(v) => void addList(v)}
				onCancel={() => setAddListOpen(false)}
			/>
		</>
	);
}
