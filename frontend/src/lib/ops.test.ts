import { describe, expect, it } from 'vitest';

import { applyOpToMaps } from './ops';
import type { Op, Task, TaskList } from './types';

function state(lists: TaskList[] = [], tasks: Task[] = []) {
	return {
		lists: new Map(lists.map((l) => [l.id, l])),
		tasks: new Map(tasks.map((t) => [t.uid, t]))
	};
}

function task(uid: string, extra: Partial<Task> = {}): Task {
	return {
		uid,
		list_id: 'l1',
		title: 't',
		notes: '',
		due: null,
		due_has_time: false,
		priority: 0,
		sort_order: null,
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: false,
		...extra
	};
}

const CREATE: Op = {
	op_id: 'o1',
	kind: 'task_create',
	uid: 'new',
	list_id: 'l1',
	title: 'Buy milk',
	notes: 'semi-skimmed',
	due: '2026-07-04',
	due_has_time: false,
	priority: 5,
	sort_order: 2048
};

describe('applyOpToMaps', () => {
	it('task_create adds an open task with the given fields', () => {
		const s = applyOpToMaps(state([{ id: 'l1', name: 'L', order: null, deleted: false }]), CREATE);
		const t = s.tasks.get('new');
		expect(t).toMatchObject({
			uid: 'new',
			list_id: 'l1',
			title: 'Buy milk',
			priority: 5,
			sort_order: 2048,
			completed: false,
			recurring: false
		});
	});

	it('task_create for an existing uid is a no-op (reapply after fold keeps the server copy)', () => {
		const existing = task('new', { title: 'server version' });
		const s = applyOpToMaps(state([], [existing]), CREATE);
		expect(s.tasks.get('new')?.title).toBe('server version');
	});

	it('task_update merges only the carried fields', () => {
		const s = applyOpToMaps(state([], [task('a', { notes: 'keep' })]), {
			op_id: 'o2',
			kind: 'task_update',
			uid: 'a',
			title: 'renamed',
			priority: 1
		});
		expect(s.tasks.get('a')).toMatchObject({ title: 'renamed', priority: 1, notes: 'keep' });
	});

	it('task_update for a task deleted server-side is a no-op', () => {
		const s = applyOpToMaps(state(), { op_id: 'o', kind: 'task_update', uid: 'ghost', title: 'x' });
		expect(s.tasks.size).toBe(0);
	});

	it('task_update sets and clears sort_order without touching other fields', () => {
		let s = applyOpToMaps(state([], [task('a', { title: 'keep', sort_order: null })]), {
			op_id: 'o1',
			kind: 'task_update',
			uid: 'a',
			sort_order: 3584
		});
		expect(s.tasks.get('a')).toMatchObject({ title: 'keep', sort_order: 3584 });
		s = applyOpToMaps(s, { op_id: 'o2', kind: 'task_update', uid: 'a', sort_order: null });
		expect(s.tasks.get('a')?.sort_order).toBeNull();
	});

	it('task_update without sort_order leaves the stored key alone', () => {
		const s = applyOpToMaps(state([], [task('a', { sort_order: 1024 })]), {
			op_id: 'o',
			kind: 'task_update',
			uid: 'a',
			title: 'renamed'
		});
		expect(s.tasks.get('a')).toMatchObject({ title: 'renamed', sort_order: 1024 });
	});

	it('task_complete / task_uncomplete flip completion', () => {
		let s = applyOpToMaps(state([], [task('a')]), {
			op_id: 'o',
			kind: 'task_complete',
			uid: 'a',
			completed_at: '2026-07-03T10:00:00',
			occurrence_due: null
		});
		expect(s.tasks.get('a')).toMatchObject({
			completed: true,
			completed_at: '2026-07-03T10:00:00'
		});
		s = applyOpToMaps(s, { op_id: 'o2', kind: 'task_uncomplete', uid: 'a' });
		expect(s.tasks.get('a')).toMatchObject({ completed: false, completed_at: null });
	});

	it('task_move rehomes the task to the destination (list_id is the source hint)', () => {
		const s = applyOpToMaps(state([], [task('a')]), {
			op_id: 'o',
			kind: 'task_move',
			uid: 'a',
			list_id: 'l1',
			to_list_id: 'l2'
		});
		expect(s.tasks.get('a')?.list_id).toBe('l2');
	});

	it('task_delete removes the task', () => {
		const s = applyOpToMaps(state([], [task('a')]), { op_id: 'o', kind: 'task_delete', uid: 'a' });
		expect(s.tasks.has('a')).toBe(false);
	});

	it('list_create / list_rename / list_delete manage lists; delete cascades', () => {
		let s = applyOpToMaps(state(), { op_id: 'o', kind: 'list_create', list_id: 'l9', name: 'Chores' });
		expect(s.lists.get('l9')).toMatchObject({ name: 'Chores', order: null, deleted: false });

		s = applyOpToMaps(s, { op_id: 'o2', kind: 'list_rename', list_id: 'l9', name: 'Home' });
		expect(s.lists.get('l9')?.name).toBe('Home');

		s.tasks.set('inside', task('inside', { list_id: 'l9' }));
		s = applyOpToMaps(s, { op_id: 'o3', kind: 'list_delete', list_id: 'l9' });
		expect(s.lists.has('l9')).toBe(false);
		expect(s.tasks.has('inside')).toBe(false);
	});

	it('list_reorder sets the order optimistically, preserving the rest', () => {
		const s0 = state([{ id: 'l1', name: 'L', order: 4, deleted: false }]);
		const s = applyOpToMaps(s0, { op_id: 'o', kind: 'list_reorder', list_id: 'l1', order: 0 });
		expect(s.lists.get('l1')).toEqual({ id: 'l1', name: 'L', order: 0, deleted: false });
		expect(s0.lists.get('l1')?.order).toBe(4); // input untouched
	});

	it('list_reorder for a List deleted server-side is a no-op', () => {
		const s = applyOpToMaps(state(), { op_id: 'o', kind: 'list_reorder', list_id: 'ghost', order: 1 });
		expect(s.lists.size).toBe(0);
	});

	it('does not mutate the input maps', () => {
		const before = state([], [task('a')]);
		applyOpToMaps(before, { op_id: 'o', kind: 'task_delete', uid: 'a' });
		expect(before.tasks.has('a')).toBe(true);
	});
});
