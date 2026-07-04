import { describe, expect, it } from 'vitest';

import {
	coerceSortMode,
	comparatorFor,
	compareCustom,
	compareDueDate,
	comparePriority,
	nextSortOrder,
	planTaskReorder,
	SORT_GAP,
	sortModeMetaKey,
	type TaskOrderChange
} from './sort';
import type { Priority, Task } from './types';
import { applyReorder } from './ui/reorderMath';

let n = 0;
function task(title: string, extra: Partial<Task> = {}): Task {
	n += 1;
	return {
		uid: `u${n}-${title}`,
		list_id: 'l',
		title,
		notes: '',
		due: null,
		due_has_time: false,
		priority: 0 as Priority,
		sort_order: null,
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: false,
		...extra
	};
}

const titles = (tasks: Task[]): string[] => tasks.map((t) => t.title);

describe('sort mode plumbing', () => {
	it('meta key is per list', () => {
		expect(sortModeMetaKey('groceries')).toBe('sort_mode:groceries');
	});

	it.each([
		['custom', 'custom'],
		['priority', 'priority'],
		['due', 'due'],
		['nonsense', 'custom'],
		[undefined, 'custom'],
		[null, 'custom'],
		[42, 'custom']
	])('coerceSortMode(%j) → %s', (raw, want) => {
		expect(coerceSortMode(raw)).toBe(want);
	});

	it('comparatorFor maps each mode', () => {
		expect(comparatorFor('custom')).toBe(compareCustom);
		expect(comparatorFor('priority')).toBe(comparePriority);
		expect(comparatorFor('due')).toBe(compareDueDate);
	});
});

describe('compareCustom', () => {
	it('orders by sort_order ascending, nulls last', () => {
		const rows = [
			task('never-ordered'),
			task('third', { sort_order: 3072 }),
			task('first', { sort_order: -917 }), // Apple keys can be any signed int
			task('second', { sort_order: 1024 })
		];
		expect(titles(rows.sort(compareCustom))).toEqual([
			'first',
			'second',
			'third',
			'never-ordered'
		]);
	});

	it('breaks sort_order ties by title, then uid (total order)', () => {
		const b = task('bravo', { sort_order: 1024 });
		const a = task('alpha', { sort_order: 1024 });
		expect(compareCustom(a, b)).toBeLessThan(0);
		expect(compareCustom(b, a)).toBeGreaterThan(0);
		const t1 = { ...task('same'), uid: 'aaa' };
		const t2 = { ...task('same'), uid: 'zzz' };
		expect(compareCustom(t1, t2)).toBeLessThan(0);
		expect(compareCustom(t2, t1)).toBeGreaterThan(0);
		expect(compareCustom(t1, t1)).toBe(0);
	});

	it('orders null pairs by title', () => {
		const rows = [task('zulu'), task('alpha')];
		expect(titles(rows.sort(compareCustom))).toEqual(['alpha', 'zulu']);
	});
});

describe('comparePriority', () => {
	it('orders High → Medium → Low → None', () => {
		const rows = [
			task('none', { priority: 0 }),
			task('low', { priority: 9 }),
			task('high', { priority: 1 }),
			task('medium', { priority: 5 })
		];
		expect(titles(rows.sort(comparePriority))).toEqual(['high', 'medium', 'low', 'none']);
	});

	it('breaks priority ties by due asc nulls-last, then title', () => {
		const rows = [
			task('no-due', { priority: 1 }),
			task('later', { priority: 1, due: '2026-07-09' }),
			task('sooner', { priority: 1, due: '2026-07-05' })
		];
		expect(titles(rows.sort(comparePriority))).toEqual(['sooner', 'later', 'no-due']);
		const rows2 = [
			task('b', { priority: 5, due: '2026-07-05' }),
			task('a', { priority: 5, due: '2026-07-05' })
		];
		expect(titles(rows2.sort(comparePriority))).toEqual(['a', 'b']);
	});

	it('is datetime-aware within a day (all-day first, then by time)', () => {
		const rows = [
			task('evening', { priority: 1, due: '2026-07-05T18:00:00', due_has_time: true }),
			task('morning', { priority: 1, due: '2026-07-05T08:00:00', due_has_time: true }),
			task('all-day', { priority: 1, due: '2026-07-05' })
		];
		expect(titles(rows.sort(comparePriority))).toEqual(['all-day', 'morning', 'evening']);
	});
});

describe('compareDueDate', () => {
	it('orders by due ascending (datetime-aware), nulls last', () => {
		const rows = [
			task('none-a'),
			task('tomorrow', { due: '2026-07-06' }),
			task('today-late', { due: '2026-07-05T22:00:00', due_has_time: true }),
			task('today', { due: '2026-07-05' })
		];
		expect(titles(rows.sort(compareDueDate))).toEqual([
			'today',
			'today-late',
			'tomorrow',
			'none-a'
		]);
	});

	it('breaks due ties by priority, then title', () => {
		const rows = [
			task('none', { due: '2026-07-05', priority: 0 }),
			task('b-high', { due: '2026-07-05', priority: 1 }),
			task('a-high', { due: '2026-07-05', priority: 1 }),
			task('low', { due: '2026-07-05', priority: 9 })
		];
		expect(titles(rows.sort(compareDueDate))).toEqual(['a-high', 'b-high', 'low', 'none']);
		const nulls = [task('z-none'), task('a-none', { priority: 9 })];
		expect(titles(nulls.sort(compareDueDate))).toEqual(['a-none', 'z-none']);
	});
});

describe('nextSortOrder (quick-add lands at the bottom)', () => {
	it('is SORT_GAP for an empty / never-ordered list', () => {
		expect(nextSortOrder([])).toBe(SORT_GAP);
		expect(nextSortOrder([task('a'), task('b')])).toBe(SORT_GAP);
	});

	it('is max concrete key + SORT_GAP, ignoring nulls', () => {
		expect(
			nextSortOrder([task('a', { sort_order: 1024 }), task('b', { sort_order: 4096 }), task('c')])
		).toBe(4096 + SORT_GAP);
	});

	it('ignores completed tasks', () => {
		expect(
			nextSortOrder([
				task('open', { sort_order: 1024 }),
				task('done', { sort_order: 9999999, completed: true, completed_at: 'x' })
			])
		).toBe(1024 + SORT_GAP);
	});

	it('works from negative keys', () => {
		expect(nextSortOrder([task('a', { sort_order: -5000 })])).toBe(-5000 + SORT_GAP);
	});
});

/** Apply a plan to the rows (pure) and re-sort with compareCustom. */
function afterPlan(rows: Task[], changes: TaskOrderChange[]): Task[] {
	const by = new Map(changes.map((c) => [c.uid, c.sort_order]));
	return rows
		.map((t) => (by.has(t.uid) ? { ...t, sort_order: by.get(t.uid) as number } : t))
		.sort(compareCustom);
}

/** The drop's intended visual order. */
function intended(rows: Task[], from: number, to: number): string[] {
	return titles(applyReorder(rows, from, to));
}

describe('planTaskReorder', () => {
	it('no-op for from === to and out-of-range indices', () => {
		const rows = [task('a', { sort_order: 1024 }), task('b', { sort_order: 2048 })];
		expect(planTaskReorder(rows, 1, 1)).toEqual([]);
		expect(planTaskReorder(rows, -1, 0)).toEqual([]);
		expect(planTaskReorder(rows, 0, 2)).toEqual([]);
	});

	it('drop between spaced neighbors takes the midpoint — ONE op', () => {
		const rows = [
			task('a', { sort_order: 1024 }),
			task('b', { sort_order: 2048 }),
			task('c', { sort_order: 3072 }),
			task('d', { sort_order: 4096 })
		];
		// Drag a down two slots: lands between c (3072) and d (4096).
		const plan = planTaskReorder(rows, 0, 2);
		expect(plan).toEqual([{ uid: rows[0]!.uid, sort_order: 3584 }]);
		expect(titles(afterPlan(rows, plan))).toEqual(intended(rows, 0, 2));
	});

	it('drop at the top goes SORT_GAP below the first key — ONE op, negatives ok', () => {
		const rows = [
			task('a', { sort_order: 100 }),
			task('b', { sort_order: 2048 }),
			task('c', { sort_order: 3072 })
		];
		const plan = planTaskReorder(rows, 2, 0);
		expect(plan).toEqual([{ uid: rows[2]!.uid, sort_order: 100 - SORT_GAP }]);
		expect(titles(afterPlan(rows, plan))).toEqual(['c', 'a', 'b']);
	});

	it('drop at the bottom goes SORT_GAP above the last concrete key — ONE op', () => {
		const rows = [
			task('a', { sort_order: 1024 }),
			task('b', { sort_order: 2048 }),
			task('c', { sort_order: 3072 })
		];
		const plan = planTaskReorder(rows, 0, 2);
		expect(plan).toEqual([{ uid: rows[0]!.uid, sort_order: 3072 + SORT_GAP }]);
		expect(titles(afterPlan(rows, plan))).toEqual(['b', 'c', 'a']);
	});

	it('adjacent swap downward is one midpoint op', () => {
		const rows = [
			task('a', { sort_order: 0 }),
			task('b', { sort_order: 1024 }),
			task('c', { sort_order: 4096 })
		];
		const plan = planTaskReorder(rows, 0, 1);
		expect(plan).toEqual([{ uid: rows[0]!.uid, sort_order: 1024 + 1536 }]);
		expect(titles(afterPlan(rows, plan))).toEqual(['b', 'a', 'c']);
	});

	it('exhausted gap re-spaces ONLY the necessary neighbors, spread evenly', () => {
		// Dropping d between a(10) and b(11) has no room; b must re-space but
		// c(600) survives as the ceiling; a is untouched.
		const rows = [
			task('a', { sort_order: 10 }),
			task('b', { sort_order: 11 }),
			task('c', { sort_order: 600 }),
			task('d', { sort_order: 2000 })
		];
		const plan = planTaskReorder(rows, 3, 1);
		// Spread evenly across (10, 600): step floor(590/3)=196 → d=206, b=402.
		expect(plan).toEqual([
			{ uid: rows[3]!.uid, sort_order: 206 },
			{ uid: rows[1]!.uid, sort_order: 402 }
		]);
		expect(titles(afterPlan(rows, plan))).toEqual(['a', 'd', 'b', 'c']);
	});

	it('exhausted gap with a tight but sufficient ceiling stays strictly increasing', () => {
		const rows = [
			task('a', { sort_order: 10 }),
			task('b', { sort_order: 11 }),
			task('c', { sort_order: 13 }),
			task('d', { sort_order: 5000 })
		];
		const plan = planTaskReorder(rows, 3, 1); // d between a(10) and b(11); c(13) survives
		expect(plan).toEqual([
			{ uid: rows[3]!.uid, sort_order: 11 },
			{ uid: rows[1]!.uid, sort_order: 12 }
		]);
		const after = afterPlan(rows, plan);
		expect(titles(after)).toEqual(['a', 'd', 'b', 'c']);
		const keys = after.map((t) => t.sort_order as number);
		expect([...keys].sort((x, y) => x - y)).toEqual(keys);
		expect(new Set(keys).size).toBe(keys.length);
		expect(plan.map((p) => p.uid)).not.toContain(rows[0]!.uid); // a untouched
		expect(plan.map((p) => p.uid)).not.toContain(rows[2]!.uid); // c untouched
	});

	it('exhausted gap cascading to the very end re-spaces with full gaps', () => {
		const rows = [
			task('a', { sort_order: 10 }),
			task('b', { sort_order: 11 }),
			task('c', { sort_order: 12 })
		];
		const plan = planTaskReorder(rows, 2, 1); // c between a and b; b then has no room
		expect(plan).toEqual([
			{ uid: rows[2]!.uid, sort_order: 10 + SORT_GAP },
			{ uid: rows[1]!.uid, sort_order: 10 + 2 * SORT_GAP }
		]);
		expect(titles(afterPlan(rows, plan))).toEqual(['a', 'c', 'b']);
	});

	it('dropping into the null suffix materializes keys for the nulls that must precede', () => {
		const rows = [
			task('a', { sort_order: 2048 }),
			task('x'), // null
			task('y') // null
		];
		// Drag a to the very bottom: x and y must gain keys so a can follow them
		// (a itself moved away, so the fresh chain starts at SORT_GAP).
		const plan = planTaskReorder(rows, 0, 2);
		expect(plan).toEqual([
			{ uid: rows[1]!.uid, sort_order: SORT_GAP },
			{ uid: rows[2]!.uid, sort_order: 2 * SORT_GAP },
			{ uid: rows[0]!.uid, sort_order: 3 * SORT_GAP }
		]);
		expect(titles(afterPlan(rows, plan))).toEqual(['x', 'y', 'a']);
	});

	it('dropping into the null suffix continues from the concrete prefix', () => {
		const rows = [
			task('a', { sort_order: 512 }),
			task('b', { sort_order: 2048 }),
			task('x'), // null
			task('y') // null
		];
		// Drag b below x: x must gain a key > 512; y stays null after b.
		const plan = planTaskReorder(rows, 1, 2);
		expect(plan).toEqual([
			{ uid: rows[2]!.uid, sort_order: 512 + SORT_GAP },
			{ uid: rows[1]!.uid, sort_order: 512 + 2 * SORT_GAP }
		]);
		const after = afterPlan(rows, plan);
		expect(titles(after)).toEqual(['a', 'x', 'b', 'y']);
		expect(after[3]!.sort_order).toBeNull();
	});

	it('a never-ordered list dragged to the top emits ONE op; the null tail stays null', () => {
		const rows = [task('a'), task('b'), task('c')];
		const plan = planTaskReorder(rows, 2, 0);
		expect(plan).toEqual([{ uid: rows[2]!.uid, sort_order: SORT_GAP }]);
		const after = afterPlan(rows, plan);
		expect(titles(after)).toEqual(['c', 'a', 'b']);
		expect(after[1]!.sort_order).toBeNull();
		expect(after[2]!.sort_order).toBeNull();
	});

	it('a never-ordered list dragged to the bottom keys everything before it', () => {
		const rows = [task('a'), task('b'), task('c')];
		const plan = planTaskReorder(rows, 0, 2);
		expect(plan).toEqual([
			{ uid: rows[1]!.uid, sort_order: SORT_GAP },
			{ uid: rows[2]!.uid, sort_order: 2 * SORT_GAP },
			{ uid: rows[0]!.uid, sort_order: 3 * SORT_GAP }
		]);
		expect(titles(afterPlan(rows, plan))).toEqual(['b', 'c', 'a']);
	});

	it('dropping a null-keyed row between concrete keys is ONE midpoint op', () => {
		const rows = [
			task('a', { sort_order: 1024 }),
			task('b', { sort_order: 2048 }),
			task('x') // null, sorted last
		];
		const plan = planTaskReorder(rows, 2, 1);
		expect(plan).toEqual([{ uid: rows[2]!.uid, sort_order: 1536 }]);
		expect(titles(afterPlan(rows, plan))).toEqual(['a', 'x', 'b']);
	});

	it('dropping right before the null suffix appends after the last concrete key', () => {
		const rows = [
			task('a', { sort_order: 1024 }),
			task('b', { sort_order: 2048 }),
			task('x'),
			task('y')
		];
		const plan = planTaskReorder(rows, 0, 1); // a between b and the null x
		expect(plan).toEqual([{ uid: rows[0]!.uid, sort_order: 2048 + SORT_GAP }]);
		expect(titles(afterPlan(rows, plan))).toEqual(['b', 'a', 'x', 'y']);
	});

	it('never emits an op for a row whose key already equals the planned one', () => {
		// Duplicate keys: dragging b above a must not touch a.
		const rows = [
			{ ...task('a', { sort_order: 10 }), uid: 'a1' },
			{ ...task('b', { sort_order: 10 }), uid: 'b1' }
		];
		const plan = planTaskReorder(rows, 1, 0);
		expect(plan).toEqual([{ uid: 'b1', sort_order: 10 - SORT_GAP }]);
		expect(titles(afterPlan(rows, plan))).toEqual(['b', 'a']);
	});

	// Deterministic fuzz: for MANY (rows, from, to) shapes the plan must
	// (a) re-sort to exactly the dropped arrangement, (b) never touch rows
	// outside the necessary set when a plain midpoint/top/bottom insert exists.
	it('property: applying the plan always yields the dropped arrangement', () => {
		let seed = 42;
		const rand = (): number => {
			// xorshift32 — deterministic across runs.
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) / 0xffffffff;
		};
		for (let round = 0; round < 250; round++) {
			const size = 2 + Math.floor(rand() * 7);
			const rows: Task[] = [];
			let key = Math.floor(rand() * 100) - 50;
			for (let i = 0; i < size; i++) {
				// Mix of tight, spaced, duplicate and null keys.
				key += rand() < 0.3 ? (rand() < 0.5 ? 0 : 1) : Math.floor(rand() * 2000);
				rows.push(task(`t${round}-${i}`, { sort_order: rand() < 0.3 ? null : key }));
			}
			rows.sort(compareCustom); // display order — the planner's precondition
			const from = Math.floor(rand() * size);
			let to = Math.floor(rand() * size);
			if (to === from) to = (to + 1) % size;
			const plan = planTaskReorder(rows, from, to);
			expect(titles(afterPlan(rows, plan))).toEqual(intended(rows, from, to));
			// Never more ops than rows; untouched rows keep their keys by design.
			expect(plan.length).toBeLessThanOrEqual(rows.length);
		}
	});
});
