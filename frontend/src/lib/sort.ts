/**
 * Per-List task sorting (contract delta v1.3): the three sort modes' pure
 * comparators, plus the Custom-order maintenance math — spaced `sort_order`
 * keys (gap 1024), midpoint insertion, and a MINIMAL re-space plan when a gap
 * is exhausted. Pure functions over Task values; nothing here touches storage,
 * network, or the DOM. The per-List mode itself is a device-local preference
 * persisted in IndexedDB meta (`sort_mode:<listId>`) by the List screen.
 */
import { compareDue } from './dates';
import type { Task } from './types';
import { applyReorder } from './ui/reorderMath';

/** The three per-List sort modes; 'custom' is the default. */
export type SortMode = 'custom' | 'priority' | 'due';

export const SORT_MODES: readonly SortMode[] = ['custom', 'priority', 'due'];

/** IndexedDB meta key holding a List's device-local sort mode. */
export function sortModeMetaKey(listId: string): string {
	return `sort_mode:${listId}`;
}

/** Anything unknown (corrupt meta, older builds) falls back to 'custom'. */
export function coerceSortMode(value: unknown): SortMode {
	return SORT_MODES.includes(value as SortMode) ? (value as SortMode) : 'custom';
}

/** Spacing between consecutive Custom keys — room for ~10 midpoint splits. */
export const SORT_GAP = 1024;

/** Priority rank High(1) → Medium(5) → Low(9) → None(0) (Apple mapping). */
export function priorityRank(t: Pick<Task, 'priority'>): number {
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

function compareTitle(a: Task, b: Task): number {
	return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
}

/** Final tie-break so every comparator is a total, stable order. */
function compareUid(a: Task, b: Task): number {
	return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/** 'custom': `sort_order` asc, nulls last, then title, then uid. */
export function compareCustom(a: Task, b: Task): number {
	const ka = a.sort_order;
	const kb = b.sort_order;
	if (ka !== kb) {
		if (ka === null) return 1;
		if (kb === null) return -1;
		return ka - kb;
	}
	return compareTitle(a, b) || compareUid(a, b);
}

/** 'priority': High→Medium→Low→None; ties by due asc nulls-last, then title. */
export function comparePriority(a: Task, b: Task): number {
	return (
		priorityRank(a) - priorityRank(b) || compareDue(a, b) || compareTitle(a, b) || compareUid(a, b)
	);
}

/** 'due': due asc (datetime-aware) nulls-last; ties by priority, then title. */
export function compareDueDate(a: Task, b: Task): number {
	return (
		compareDue(a, b) || priorityRank(a) - priorityRank(b) || compareTitle(a, b) || compareUid(a, b)
	);
}

export function comparatorFor(mode: SortMode): (a: Task, b: Task) => number {
	switch (mode) {
		case 'priority':
			return comparePriority;
		case 'due':
			return compareDueDate;
		default:
			return compareCustom;
	}
}

/**
 * The Custom key a quick-added Task gets so it lands at the BOTTOM of the open
 * section: max concrete key among the List's open Tasks + SORT_GAP (SORT_GAP
 * for a List with none). Completed Tasks and null keys don't count.
 */
export function nextSortOrder(tasks: Iterable<Pick<Task, 'sort_order' | 'completed'>>): number {
	let max: number | null = null;
	for (const t of tasks) {
		if (t.completed || t.sort_order === null) continue;
		if (max === null || t.sort_order > max) max = t.sort_order;
	}
	return (max ?? 0) + SORT_GAP;
}

/** One row's new Custom key — becomes a minimal `task_update` op. */
export interface TaskOrderChange {
	uid: string;
	sort_order: number;
}

/**
 * Plan the MINIMAL set of `sort_order` changes so that moving `rows[from]` to
 * position `to` re-sorts exactly to the dropped arrangement under
 * `compareCustom`. `rows` are the open section's rows in their CURRENT
 * (comparator-sorted) display order — so among the unchanged rows, concrete
 * keys are non-decreasing and null keys form a suffix.
 *
 *  - a drop between two concrete keys takes the integer midpoint;
 *  - when that gap is exhausted (< 2) the moved row lands at `low + 1` and
 *    ONLY the necessary following neighbors re-space (each was blocking the
 *    strictly-increasing chain); freed room is spread evenly;
 *  - null-keyed rows that must PRECEDE the moved row (a drop into or past the
 *    never-ordered suffix) get materialized keys at SORT_GAP steps; nulls
 *    after the drop stay null (they already sort last).
 */
export function planTaskReorder(
	rows: readonly Task[],
	from: number,
	to: number
): TaskOrderChange[] {
	if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [];
	const next = applyReorder(rows, from, to);
	const moved = next[to];
	if (!moved) return [];

	const changes: TaskOrderChange[] = [];
	const put = (t: Task, key: number): void => {
		if (t.sort_order !== key) changes.push({ uid: t.uid, sort_order: key });
	};

	// 1. Materialize keys for null rows before the slot (they must precede the
	//    moved row, and null sorts last). Sorted input ⇒ they trail the prefix.
	let low: number | null = null;
	for (let i = 0; i < to; i++) {
		const t = next[i];
		if (!t) continue;
		if (t.sort_order !== null) {
			low = t.sort_order;
			continue;
		}
		low = low === null ? SORT_GAP : low + SORT_GAP;
		put(t, low);
	}

	// 2. The first concrete key after the slot bounds the moved row from above.
	//    (If next[to+1] is null, every following row is null — sorted input.)
	const after = next[to + 1];
	const high = after !== undefined && after.sort_order !== null ? after.sort_order : null;

	if (high === null) {
		put(moved, low === null ? SORT_GAP : low + SORT_GAP);
		return changes;
	}
	if (low === null) {
		put(moved, high - SORT_GAP); // top insert — negatives are fine
		return changes;
	}
	if (high - low >= 2) {
		put(moved, low + Math.floor((high - low) / 2)); // strictly between
		return changes;
	}

	// 3. Gap exhausted: the moved row takes low+1 and every following concrete
	//    key that blocks the strictly-increasing chain must move — exactly the
	//    rows whose key is ≤ its tightest-possible predecessor (+1 packing), so
	//    the changed set is minimal. Then spread the freed room evenly.
	const movedKey = low + 1;
	const bumped: Task[] = [];
	let floorKey = movedKey;
	let j = to + 1;
	for (; j < next.length; j++) {
		const t = next[j];
		if (!t || t.sort_order === null || t.sort_order > floorKey) break;
		bumped.push(t);
		floorKey += 1;
	}
	const survivorRow = j < next.length ? next[j] : undefined;
	const survivor = survivorRow !== undefined ? survivorRow.sort_order : null;
	if (survivor === null) {
		// The cascade swallowed every remaining concrete key — nothing bounds us
		// from above (nulls sort last anyway), so re-space with full gaps.
		put(moved, low + SORT_GAP);
		bumped.forEach((t, i) => put(t, low + (i + 2) * SORT_GAP));
		return changes;
	}
	// Minimality guaranteed the room: survivor > low + bumped.length + 1, so the
	// even step is ≥ 1 and every key stays strictly below the survivor's.
	const step = Math.floor((survivor - low) / (bumped.length + 2));
	put(moved, low + step);
	bumped.forEach((t, i) => put(t, low + step * (i + 2)));
	return changes;
}
