/**
 * Smart Views — pure derivations over the Replica (CONTEXT.md): Today (due or
 * overdue today), Scheduled (has a Due, grouped by day), All (open Tasks
 * grouped by List), per-List, plus client-side search. Components call these
 * inside `$derived(...)` with the `replica` store value, so everything
 * recomputes on any Replica change. Nothing here touches storage or network.
 */
import { compareDue, dayKeyOf, formatDayHeading, isDueToday } from './dates';
import type { ReplicaState } from './ops';
import type { Task, TaskList } from './types';

export interface ViewOptions {
	showCompleted: boolean;
	now: Date;
	/** Just-completed uids kept visible briefly (strike animation grace). */
	grace?: Set<string>;
}

export interface TaskGroup {
	key: string;
	heading: string;
	tasks: Task[];
}

/** High(1) → Medium(5) → Low(9) → None(0). */
function priorityRank(t: Task): number {
	switch (t.priority) {
		case 1:
			return 0;
		case 5:
			return 1;
		case 9:
			return 2;
		default:
			return 3;
	}
}

/** Standard row order: by due (no-due last), then priority, then title. */
export function compareTasks(a: Task, b: Task): number {
	return (
		compareDue(a, b) ||
		priorityRank(a) - priorityRank(b) ||
		a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
	);
}

/** Open completed last (used when completed are shown). */
function compareWithCompletion(a: Task, b: Task): number {
	if (a.completed !== b.completed) return a.completed ? 1 : -1;
	return compareTasks(a, b);
}

function visible(t: Task, opts: ViewOptions): boolean {
	if (!t.completed) return true;
	if (opts.showCompleted) return true;
	return opts.grace?.has(t.uid) ?? false;
}

function allTasks(state: ReplicaState): Task[] {
	// Defensively exclude Tasks whose List no longer exists in the Replica (a
	// mid-cascade fold, or a List tombstone that outran its Tasks): a deleted
	// List takes its Tasks with it (contract-delta E). Feeds every Smart View.
	return [...state.tasks.values()].filter((t) => state.lists.has(t.list_id));
}

/** Lists in stable alphabetical order. */
export function sortedLists(state: ReplicaState): TaskList[] {
	return [...state.lists.values()].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
	);
}

/** Today: due today or overdue. Grace-period tasks stay put. */
export function buildTodayView(state: ReplicaState, opts: ViewOptions): Task[] {
	return allTasks(state)
		.filter((t) => isDueToday(t, opts.now) && visible(t, opts))
		.sort(compareTasks);
}

/** Scheduled: everything with a Due, grouped by local day, ascending. */
export function buildScheduledView(state: ReplicaState, opts: ViewOptions): TaskGroup[] {
	const byDay = new Map<string, Task[]>();
	for (const t of allTasks(state)) {
		if (!t.due || !visible(t, opts)) continue;
		const key = dayKeyOf(t.due);
		const bucket = byDay.get(key);
		if (bucket) bucket.push(t);
		else byDay.set(key, [t]);
	}
	return [...byDay.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([key, tasks]) => ({
			key,
			heading: formatDayHeading(key, opts.now),
			tasks: tasks.sort(compareTasks)
		}));
}

/** All: open Tasks grouped by List (alphabetical), skipping empty groups. */
export function buildAllView(state: ReplicaState, opts: ViewOptions): TaskGroup[] {
	const groups: TaskGroup[] = [];
	for (const l of sortedLists(state)) {
		const tasks = allTasks(state)
			.filter((t) => t.list_id === l.id && visible(t, opts))
			.sort(compareWithCompletion);
		if (tasks.length) groups.push({ key: l.id, heading: l.name, tasks });
	}
	return groups;
}

/** One List's Tasks; completed (when shown) sink to the bottom. */
export function buildListView(state: ReplicaState, listId: string, opts: ViewOptions): Task[] {
	return allTasks(state)
		.filter((t) => t.list_id === listId && visible(t, opts))
		.sort(compareWithCompletion);
}

function matchesQuery(t: Task, q: string): boolean {
	return t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q);
}

/** Narrow an already-built flat view by the screen's search field. */
export function filterTasks(tasks: Task[], query: string): Task[] {
	const q = query.trim().toLowerCase();
	if (!q) return tasks;
	return tasks.filter((t) => matchesQuery(t, q));
}

/** Narrow a grouped view; groups emptied by the filter disappear. */
export function filterGroups(groups: TaskGroup[], query: string): TaskGroup[] {
	const q = query.trim().toLowerCase();
	if (!q) return groups;
	return groups
		.map((g) => ({ ...g, tasks: g.tasks.filter((t) => matchesQuery(t, q)) }))
		.filter((g) => g.tasks.length > 0);
}

export interface SearchHit {
	task: Task;
	listName: string;
}

/** Case-insensitive substring search over title + notes, open hits first. */
export function searchTasks(state: ReplicaState, query: string): SearchHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return allTasks(state)
		.filter((t) => matchesQuery(t, q))
		.sort(compareWithCompletion)
		.map((task) => ({ task, listName: state.lists.get(task.list_id)?.name ?? '' }));
}

export interface ViewCounts {
	today: number;
	scheduled: number;
	all: number;
	byList: Map<string, number>;
}

/** Open-task counts for the home tiles and list rows. */
export function viewCounts(state: ReplicaState, now: Date): ViewCounts {
	const byList = new Map<string, number>();
	let today = 0;
	let scheduled = 0;
	let all = 0;
	for (const t of state.tasks.values()) {
		if (!state.lists.has(t.list_id)) continue; // orphaned by a List tombstone
		if (t.completed) continue;
		all += 1;
		if (t.due) scheduled += 1;
		if (isDueToday(t, now)) today += 1;
		byList.set(t.list_id, (byList.get(t.list_id) ?? 0) + 1);
	}
	return { today, scheduled, all, byList };
}
