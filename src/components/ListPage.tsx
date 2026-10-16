import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import {
	createTask,
	deleteList,
	recentlyCompleted,
	renameList,
	reorderTasks,
	setListSortMode,
} from "#/client/actions";
import { getMeta, setMeta } from "#/client/db";
import { replica, replicaLoaded } from "#/client/replica";
import {
	effectiveSortMode,
	planTaskReorder,
	type SortMode,
	sortModeMetaKey,
	type TaskOrderChange,
} from "#/client/sort";
import type { Priority, Task } from "#/client/types";
import { now as clock } from "#/client/ui/clock";
import { applyReorder, dragReorder } from "#/client/ui/dragReorder";
import { listColor } from "#/client/ui/listColors";
import { useStore } from "#/client/useStore";
import { buildListSections, buildListView, filterTasks } from "#/client/views";

import { ActionMenu } from "./ActionMenu";
import { AlertPrompt } from "./AlertPrompt";
import { CompletedBar } from "./CompletedBar";
import { QuickAdd } from "./QuickAdd";
import { Screen } from "./Screen";
import { TaskRow } from "./TaskRow";
import { TaskSheet } from "./TaskSheet";
import { useAction } from "./useAction";

const SORT_LABEL: Record<SortMode, string> = {
	custom: "Custom",
	priority: "Priority",
	due: "Due Date",
};

/**
 * One List's screen: its Tasks off the Replica (open section sorted by the
 * List's sort mode, completed section toggleable, everything searchable),
 * quick-add into this List, and the "…" menu with Sort By (Custom / Priority
 * / Due Date, SHARED across the household's devices via `TaskList.sort_mode`
 * and the `list_set_sort_mode` op; the pre-v0.5 device-local IndexedDB meta is
 * only a fallback while the server value is null, contract delta v1.4 §3)
 * plus rename, and delete behind a typed confirm.
 *
 * In Custom mode the open rows reorder by drag: long-press-to-lift on touch,
 * press-and-drag with a mouse (Home's dragReorder engine). A drop emits
 * MINIMAL task_update ops via planTaskReorder (contract delta v1.3 §4). In
 * Priority/Due modes the action is disabled.
 */
export function ListPage({ listId }: { listId: string }) {
	const navigate = useNavigate();
	const state = useStore(replica);
	const loaded = useStore(replicaLoaded);
	const now = useStore(clock);
	const grace = useStore(recentlyCompleted);

	const list = state.lists.get(listId);
	const tint = listColor(listId);

	const [query, setQuery] = useState("");
	const [showCompleted, setShowCompleted] = useState(false);
	const [sheetTask, setSheetTask] = useState<Task | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [sortMenuOpen, setSortMenuOpen] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);

	// Quick-add draft; the expand chevron hands it to the New-Task sheet,
	// which clears it only when it actually creates.
	const [draftTitle, setDraftTitle] = useState("");
	const [draftPriority, setDraftPriority] = useState<Priority>(0);
	const [createOpen, setCreateOpen] = useState(false);

	function clearDraft(): void {
		setDraftTitle("");
		setDraftPriority(0);
	}

	// Sort mode: shared per List via the Replica's `TaskList.sort_mode`. The
	// device-local meta is ONLY a fallback while the server value is null; it
	// is never pushed by itself, the first change from the picker lands it.
	const [localSortMode, setLocalSortMode] = useState<unknown>(undefined);
	useEffect(() => {
		let current = true;
		setLocalSortMode(undefined);
		if (!listId) return;
		void getMeta(sortModeMetaKey(listId)).then((stored) => {
			if (current) setLocalSortMode(stored);
		});
		return () => {
			current = false;
		};
	}, [listId]);
	const sortMode = effectiveSortMode(list?.sort_mode, localSortMode);

	function setSortMode(mode: SortMode): void {
		// The optimistic replica apply flips `sortMode` at once; the meta write
		// keeps this device's fallback in step for server-null Lists.
		setLocalSortMode(mode);
		void setMeta(sortModeMetaKey(listId), mode);
		void setListSortMode(listId, mode);
	}

	const sections = useMemo(
		() =>
			buildListSections(state, listId, { showCompleted, now, grace }, sortMode),
		[state, listId, showCompleted, now, grace, sortMode],
	);
	const openRows = useMemo(
		() => filterTasks(sections.open, query),
		[sections, query],
	);
	const doneRows = useMemo(
		() => filterTasks(sections.done, query),
		[sections, query],
	);
	const completedCount = useMemo(
		() =>
			buildListView(state, listId, { showCompleted: true, now }).filter(
				(t) => t.completed,
			).length,
		[state, listId, now],
	);

	// Custom-mode reorder. Search off: a drop on a filtered subset would
	// compute wrong neighbours. `pendingOrder` bridges the ms between the
	// drop's re-render (inside flushSync) and the optimistic ops re-sorting.
	const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
	const dragEnabled = sortMode === "custom" && !query.trim();

	const displayOpen = useMemo((): Task[] => {
		if (!pendingOrder) return openRows;
		const byId = new Map(openRows.map((t) => [t.uid, t]));
		return pendingOrder
			.map((id) => byId.get(id))
			.filter((t): t is Task => t !== undefined);
	}, [openRows, pendingOrder]);

	async function commitReorder(changes: TaskOrderChange[]): Promise<void> {
		try {
			await reorderTasks(changes);
		} finally {
			setPendingOrder(null);
		}
	}

	/** Drop from the dragReorder action (inside flushSync). */
	function onreorder(from: number, to: number): void {
		const rows = displayOpen;
		setPendingOrder(applyReorder(rows, from, to).map((t) => t.uid));
		void commitReorder(planTaskReorder(rows, from, to));
	}

	const rowsContainer = useAction(dragReorder, {
		enabled: dragEnabled,
		liftOnHold: true,
		onreorder,
	});

	async function quickAdd(fields: {
		title: string;
		priority: Priority;
	}): Promise<void> {
		await createTask(listId, fields);
	}

	async function rename(name: string): Promise<void> {
		setRenameOpen(false);
		if (list && name !== list.name) await renameList(listId, name);
	}

	/** Leave first, then record the Op: no "List not found" flash. */
	async function confirmDelete(): Promise<void> {
		setDeleteOpen(false);
		const id = listId;
		await navigate({ to: "/" });
		await deleteList(id);
	}

	const back = { href: "/", label: "Lists" };

	return (
		<>
			{list ? (
				<Screen
					title={list.name}
					tint={tint}
					back={back}
					right={
						<button
							type="button"
							className="menu-btn"
							aria-label="List options"
							onClick={() => setMenuOpen(true)}
						>
							<svg
								width="22"
								height="22"
								viewBox="0 0 24 24"
								fill="none"
								aria-hidden="true"
							>
								<circle
									cx="12"
									cy="12"
									r="9.25"
									stroke="currentColor"
									strokeWidth="1.5"
								/>
								<circle cx="7.5" cy="12" r="1.3" fill="currentColor" />
								<circle cx="12" cy="12" r="1.3" fill="currentColor" />
								<circle cx="16.5" cy="12" r="1.3" fill="currentColor" />
							</svg>
						</button>
					}
					bottom={
						<QuickAdd
							text={draftTitle}
							onTextChange={setDraftTitle}
							priority={draftPriority}
							onPriorityChange={setDraftPriority}
							onAdd={quickAdd}
							onExpand={() => setCreateOpen(true)}
						/>
					}
				>
					<input
						className="search"
						type="search"
						placeholder="Search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						autoComplete="off"
						aria-label={`Search in ${list.name}`}
					/>

					<CompletedBar
						count={completedCount}
						shown={showCompleted}
						onToggle={() => setShowCompleted((on) => !on)}
					/>

					{displayOpen.length === 0 && doneRows.length === 0 ? (
						<p className="empty">
							{query.trim()
								? `No results for “${query.trim()}”`
								: "No Tasks — add one below."}
						</p>
					) : (
						<div className="card hairline-rows" ref={rowsContainer}>
							{displayOpen.map((t) => (
								// Drag target in Custom mode: long-press on touch, press-and-drag
								// with a mouse. Static touch-action / callout-off, like Home's
								// rows: iOS decides the gesture before any JS runs.
								<div
									key={t.uid}
									className={dragEnabled ? "task-item draggable" : "task-item"}
									data-drag-item
								>
									<TaskRow
										task={t}
										now={now}
										tint={tint}
										onOpen={() => setSheetTask(t)}
									/>
								</div>
							))}
							{doneRows.map((t) => (
								// Completed section: never draggable, order untouched by the mode.
								<div key={t.uid} className="task-item">
									<TaskRow
										task={t}
										now={now}
										tint={tint}
										onOpen={() => setSheetTask(t)}
									/>
								</div>
							))}
						</div>
					)}
				</Screen>
			) : (
				<Screen title="List" back={back}>
					<p className="empty">
						{loaded ? "This List no longer exists." : "Loading…"}
					</p>
				</Screen>
			)}

			<TaskSheet
				open={sheetTask !== null}
				task={sheetTask}
				onClose={() => setSheetTask(null)}
			/>

			{/* Expanded quick-add: create sheet prefilled with the draft. */}
			<TaskSheet
				open={createOpen}
				defaultListId={listId}
				defaultTitle={draftTitle}
				defaultPriority={draftPriority}
				onSaved={clearDraft}
				onClose={() => setCreateOpen(false)}
			/>

			<ActionMenu
				open={menuOpen}
				title={list?.name ?? ""}
				actions={[
					{
						label: `Sort By: ${SORT_LABEL[sortMode]}`,
						action: () => setSortMenuOpen(true),
					},
					{ label: "Rename List", action: () => setRenameOpen(true) },
					{
						label: "Delete List",
						danger: true,
						action: () => setDeleteOpen(true),
					},
				]}
				onClose={() => setMenuOpen(false)}
			/>

			{/* iOS-Reminders-style Sort By picker: ✓ on the current mode, per List. */}
			<ActionMenu
				open={sortMenuOpen}
				title="Sort By"
				actions={[
					{
						label: "Custom",
						checked: sortMode === "custom",
						action: () => setSortMode("custom"),
					},
					{
						label: "Priority",
						checked: sortMode === "priority",
						action: () => setSortMode("priority"),
					},
					{
						label: "Due Date",
						checked: sortMode === "due",
						action: () => setSortMode("due"),
					},
				]}
				onClose={() => setSortMenuOpen(false)}
			/>

			<AlertPrompt
				open={renameOpen}
				title="Rename List"
				withInput
				initial={list?.name ?? ""}
				placeholder="List name"
				confirmLabel="Rename"
				onConfirm={(v) => void rename(v)}
				onCancel={() => setRenameOpen(false)}
			/>

			<AlertPrompt
				open={deleteOpen}
				title="Delete List?"
				message={`This deletes “${list?.name ?? ""}” and every Task in it from Nextcloud (recoverable from its trash bin for a while). Type the list name to confirm.`}
				requireMatch={list?.name ?? ""}
				placeholder={list?.name ?? ""}
				confirmLabel="Delete"
				danger
				onConfirm={() => void confirmDelete()}
				onCancel={() => setDeleteOpen(false)}
			/>
		</>
	);
}
