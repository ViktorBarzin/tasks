import { describe, expect, it } from 'vitest';

import type { ReplicaState } from './ops';
import type { Priority, Task, TaskList } from './types';
import { applyReorder } from './ui/reorderMath';
import {
	buildAllView,
	buildListView,
	buildScheduledView,
	buildTodayView,
	filterGroups,
	filterTasks,
	planListReorder,
	searchTasks,
	sortedLists,
	viewCounts
} from './views';

const NOW = new Date(2026, 6, 3, 10, 30, 0); // Fri 2026-07-03

function list(id: string, name: string, order: number | null = null): TaskList {
	return { id, name, order, deleted: false };
}

let n = 0;
function task(
	title: string,
	extra: Partial<Task> & { list_id?: string } = {}
): Task {
	n += 1;
	return {
		uid: `u${n}-${title}`,
		list_id: 'groceries',
		title,
		notes: '',
		due: null,
		due_has_time: false,
		priority: 0 as Priority,
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: false,
		...extra
	};
}

function state(tasks: Task[]): ReplicaState {
	return {
		lists: new Map([
			['groceries', list('groceries', 'Groceries')],
			['work', list('work', 'Work')]
		]),
		tasks: new Map(tasks.map((t) => [t.uid, t]))
	};
}

describe('buildTodayView', () => {
	it('selects open tasks due today or overdue, ordered by due', () => {
		const s = state([
			task('overdue', { due: '2026-07-01' }),
			task('today-timed', { due: '2026-07-03T09:00:00', due_has_time: true }),
			task('today', { due: '2026-07-03' }),
			task('future', { due: '2026-07-10' }),
			task('no-due'),
			task('done-today', { due: '2026-07-03', completed: true, completed_at: 'x' })
		]);
		const view = buildTodayView(s, { showCompleted: false, now: NOW });
		expect(view.map((t) => t.title)).toEqual(['overdue', 'today', 'today-timed']);
	});

	it('includes completed when toggled', () => {
		const s = state([
			task('done', { due: '2026-07-03', completed: true, completed_at: 'x' }),
			task('open', { due: '2026-07-03' })
		]);
		const view = buildTodayView(s, { showCompleted: true, now: NOW });
		expect(view.map((t) => t.title)).toEqual(['done', 'open']);
	});

	it('keeps just-completed tasks visible during the grace period', () => {
		const done = task('just-done', { due: '2026-07-03', completed: true, completed_at: 'x' });
		const s = state([done]);
		expect(buildTodayView(s, { showCompleted: false, now: NOW })).toHaveLength(0);
		const view = buildTodayView(s, {
			showCompleted: false,
			now: NOW,
			grace: new Set([done.uid])
		});
		expect(view.map((t) => t.title)).toEqual(['just-done']);
	});
});

describe('buildScheduledView', () => {
	it('groups open tasks with a due by day, ascending, overdue first', () => {
		const s = state([
			task('b-later', { due: '2026-07-05' }),
			task('a-overdue', { due: '2026-07-01' }),
			task('c-timed', { due: '2026-07-05T18:00:00', due_has_time: true }),
			task('no-due')
		]);
		const groups = buildScheduledView(s, { showCompleted: false, now: NOW });
		expect(groups.map((g) => g.key)).toEqual(['2026-07-01', '2026-07-05']);
		expect(groups[1]!.tasks.map((t) => t.title)).toEqual(['b-later', 'c-timed']);
		expect(groups[0]!.heading).toMatch(/1 Jul/);
	});
});

describe('buildAllView', () => {
	it('groups open tasks by list, lists alphabetical', () => {
		const s = state([
			task('milk'),
			task('report', { list_id: 'work' }),
			task('done', { completed: true, completed_at: 'x' })
		]);
		const groups = buildAllView(s, { showCompleted: false, now: NOW });
		expect(groups.map((g) => g.heading)).toEqual(['Groceries', 'Work']);
		expect(groups[0]!.tasks.map((t) => t.title)).toEqual(['milk']);
	});

	it('hides empty lists unless completed are shown', () => {
		const s = state([task('done', { list_id: 'work', completed: true, completed_at: 'x' })]);
		expect(buildAllView(s, { showCompleted: false, now: NOW })).toHaveLength(0);
		const withDone = buildAllView(s, { showCompleted: true, now: NOW });
		expect(withDone.map((g) => g.heading)).toEqual(['Work']);
	});
});

describe('buildListView', () => {
	it('sorts: due first (by date), then priority, then title; completed hidden by default', () => {
		const s = state([
			task('zebra'),
			task('apple'),
			task('high', { priority: 1 }),
			task('due', { due: '2026-07-09' }),
			task('done', { completed: true, completed_at: 'x' })
		]);
		const view = buildListView(s, 'groceries', { showCompleted: false, now: NOW });
		expect(view.map((t) => t.title)).toEqual(['due', 'high', 'apple', 'zebra']);
	});

	it('appends completed at the bottom when shown', () => {
		const s = state([
			task('open'),
			task('done', { completed: true, completed_at: 'x' })
		]);
		const view = buildListView(s, 'groceries', { showCompleted: true, now: NOW });
		expect(view.map((t) => t.title)).toEqual(['open', 'done']);
	});
});

describe('searchTasks', () => {
	it('matches title and notes case-insensitively, open before completed', () => {
		const s = state([
			task('Buy MILK'),
			task('note match', { notes: 'the milkman cometh' }),
			task('done milk', { completed: true, completed_at: 'x' }),
			task('unrelated')
		]);
		const hits = searchTasks(s, 'milk');
		expect(hits.map((h) => h.task.title)).toEqual(['Buy MILK', 'note match', 'done milk']);
		expect(hits[0]!.listName).toBe('Groceries');
	});

	it('returns nothing for a blank query', () => {
		expect(searchTasks(state([task('x')]), '  ')).toEqual([]);
	});
});

describe('filterTasks / filterGroups', () => {
	it('filters a built view by title/notes, preserving order', () => {
		const rows = [
			task('Buy milk'),
			task('call plumber', { notes: 'about the milk frother' }),
			task('unrelated')
		];
		expect(filterTasks(rows, 'MILK').map((t) => t.title)).toEqual(['Buy milk', 'call plumber']);
	});

	it('blank query keeps every row', () => {
		const rows = [task('a'), task('b')];
		expect(filterTasks(rows, '  ')).toEqual(rows);
	});

	it('filters within groups and drops groups left empty', () => {
		const groups = [
			{ key: 'g1', heading: 'One', tasks: [task('milk'), task('bread')] },
			{ key: 'g2', heading: 'Two', tasks: [task('report')] }
		];
		const out = filterGroups(groups, 'milk');
		expect(out.map((g) => g.key)).toEqual(['g1']);
		expect(out[0]!.tasks.map((t) => t.title)).toEqual(['milk']);
	});

	it('blank query returns groups untouched', () => {
		const groups = [{ key: 'g', heading: 'G', tasks: [task('x')] }];
		expect(filterGroups(groups, '')).toEqual(groups);
	});
});

describe('orphaned tasks (List gone, §E)', () => {
	it('are excluded from every Smart View, search, and the counts', () => {
		const s = state([
			task('live', { due: '2026-07-03' }),
			task('orphan', { due: '2026-07-03', list_id: 'ghost', notes: 'live' })
		]);
		expect(buildTodayView(s, { showCompleted: false, now: NOW }).map((t) => t.title)).toEqual([
			'live'
		]);
		const scheduled = buildScheduledView(s, { showCompleted: false, now: NOW });
		expect(scheduled.flatMap((g) => g.tasks.map((t) => t.title))).toEqual(['live']);
		const all = buildAllView(s, { showCompleted: false, now: NOW });
		expect(all.flatMap((g) => g.tasks.map((t) => t.title))).toEqual(['live']);
		// "live" matches both the title and the orphan's notes; only the live one surfaces.
		expect(searchTasks(s, 'live').map((h) => h.task.title)).toEqual(['live']);
		const counts = viewCounts(s, NOW);
		expect(counts.today).toBe(1);
		expect(counts.all).toBe(1);
		expect(counts.byList.has('ghost')).toBe(false);
	});
});

describe('viewCounts / sortedLists', () => {
	it('counts open tasks for tiles and per list', () => {
		const s = state([
			task('overdue', { due: '2026-06-01' }),
			task('today', { due: '2026-07-03' }),
			task('later', { due: '2026-08-01', list_id: 'work' }),
			task('no-due', { list_id: 'work' }),
			task('done', { due: '2026-07-03', completed: true, completed_at: 'x' })
		]);
		const counts = viewCounts(s, NOW);
		expect(counts.today).toBe(2);
		expect(counts.scheduled).toBe(3);
		expect(counts.all).toBe(4);
		expect(counts.byList.get('groceries')).toBe(2);
		expect(counts.byList.get('work')).toBe(2);
	});

	it('sortedLists is alphabetical when no List carries an order', () => {
		const s = state([]);
		expect(sortedLists(s).map((l) => l.name)).toEqual(['Groceries', 'Work']);
	});
});

describe('sortedLists with calendar-order (contract v1.2)', () => {
	function withLists(lists: TaskList[]): ReplicaState {
		return { lists: new Map(lists.map((l) => [l.id, l])), tasks: new Map() };
	}

	it('sorts by order first, unordered Lists sink below, alphabetical within ties', () => {
		const s = withLists([
			list('zulu', 'Zulu', 0),
			list('alpha', 'Alpha', null),
			list('mid', 'Mid', 2),
			list('beta', 'Beta', null),
			list('tie-b', 'B-tie', 1),
			list('tie-a', 'A-tie', 1)
		]);
		expect(sortedLists(s).map((l) => l.id)).toEqual([
			'zulu', // 0
			'tie-a', // 1, name tie-break
			'tie-b', // 1
			'mid', // 2
			'alpha', // unordered, alphabetical
			'beta'
		]);
	});

	it('buildAllView groups follow the List order', () => {
		const s: ReplicaState = {
			lists: new Map([
				['groceries', list('groceries', 'Groceries', 1)],
				['work', list('work', 'Work', 0)]
			]),
			tasks: new Map()
		};
		s.tasks.set('a', task('milk'));
		s.tasks.set('b', task('report', { list_id: 'work' }));
		const groups = buildAllView(s, { showCompleted: false, now: NOW });
		expect(groups.map((g) => g.heading)).toEqual(['Work', 'Groceries']);
	});
});

describe('planListReorder', () => {
	const lists = [list('a', 'A', 0), list('b', 'B', 1), list('c', 'C', 2)];

	it('emits one op per List whose stored order differs from its new index', () => {
		// Drag C to the front: every position shifts.
		expect(planListReorder(lists, ['c', 'a', 'b'])).toEqual([
			{ listId: 'c', order: 0 },
			{ listId: 'a', order: 1 },
			{ listId: 'b', order: 2 }
		]);
	});

	it('emits nothing when the order is unchanged', () => {
		expect(planListReorder(lists, ['a', 'b', 'c'])).toEqual([]);
	});

	it('only the moved tail changes when the head keeps its positions', () => {
		expect(planListReorder(lists, ['a', 'c', 'b'])).toEqual([
			{ listId: 'c', order: 1 },
			{ listId: 'b', order: 2 }
		]);
	});

	it('a first-ever reorder (all orders null) emits one op per List', () => {
		const fresh = [list('a', 'A'), list('b', 'B'), list('c', 'C')];
		expect(planListReorder(fresh, ['b', 'a', 'c'])).toEqual([
			{ listId: 'b', order: 0 },
			{ listId: 'a', order: 1 },
			{ listId: 'c', order: 2 }
		]);
	});

	it('ignores ids that vanished from the Replica mid-drag', () => {
		expect(planListReorder(lists, ['ghost', 'a', 'b', 'c'])).toEqual([
			{ listId: 'a', order: 1 },
			{ listId: 'b', order: 2 },
			{ listId: 'c', order: 3 }
		]);
	});

	// A drop is applyReorder(from, to) → planListReorder: pin that the composed
	// op set stays MINIMAL — exactly the Lists whose position changed, never all.
	describe('composed with a drag-and-drop (applyReorder)', () => {
		const five = [
			list('a', 'A', 0),
			list('b', 'B', 1),
			list('c', 'C', 2),
			list('d', 'D', 3),
			list('e', 'E', 4)
		];
		const ids = five.map((l) => l.id);

		it('row 0 → position 3 touches exactly the four displaced Lists', () => {
			expect(planListReorder(five, applyReorder(ids, 0, 3))).toEqual([
				{ listId: 'b', order: 0 },
				{ listId: 'c', order: 1 },
				{ listId: 'd', order: 2 },
				{ listId: 'a', order: 3 }
			]);
		});

		it('row 4 → position 1 leaves the untouched head out of the op set', () => {
			expect(planListReorder(five, applyReorder(ids, 4, 1))).toEqual([
				{ listId: 'e', order: 1 },
				{ listId: 'b', order: 2 },
				{ listId: 'c', order: 3 },
				{ listId: 'd', order: 4 }
			]);
		});

		it('an adjacent swap emits exactly two ops', () => {
			expect(planListReorder(five, applyReorder(ids, 2, 3))).toEqual([
				{ listId: 'd', order: 2 },
				{ listId: 'c', order: 3 }
			]);
		});

		it('a jitter drop (from === to) emits no ops at all', () => {
			for (let i = 0; i < ids.length; i++) {
				expect(planListReorder(five, applyReorder(ids, i, i))).toEqual([]);
			}
		});
	});
});
