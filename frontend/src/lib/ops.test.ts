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
	priority: 5
};

describe('applyOpToMaps', () => {
	it('task_create adds an open task with the given fields', () => {
		const s = applyOpToMaps(state([{ id: 'l1', name: 'L', deleted: false }]), CREATE);
		const t = s.tasks.get('new');
		expect(t).toMatchObject({
			uid: 'new',
			list_id: 'l1',
			title: 'Buy milk',
			priority: 5,
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

	it('task_complete / task_uncomplete flip completion', () => {
		let s = applyOpToMaps(state([], [task('a')]), {
			op_id: 'o',
			kind: 'task_complete',
			uid: 'a',
			completed_at: '2026-07-03T10:00:00'
		});
		expect(s.tasks.get('a')).toMatchObject({
			completed: true,
			completed_at: '2026-07-03T10:00:00'
		});
		s = applyOpToMaps(s, { op_id: 'o2', kind: 'task_uncomplete', uid: 'a' });
		expect(s.tasks.get('a')).toMatchObject({ completed: false, completed_at: null });
	});

	it('task_move rehomes the task', () => {
		const s = applyOpToMaps(state([], [task('a')]), {
			op_id: 'o',
			kind: 'task_move',
			uid: 'a',
			list_id: 'l2'
		});
		expect(s.tasks.get('a')?.list_id).toBe('l2');
	});

	it('task_delete removes the task', () => {
		const s = applyOpToMaps(state([], [task('a')]), { op_id: 'o', kind: 'task_delete', uid: 'a' });
		expect(s.tasks.has('a')).toBe(false);
	});

	it('list_create / list_rename / list_delete manage lists; delete cascades', () => {
		let s = applyOpToMaps(state(), { op_id: 'o', kind: 'list_create', list_id: 'l9', name: 'Chores' });
		expect(s.lists.get('l9')).toMatchObject({ name: 'Chores', deleted: false });

		s = applyOpToMaps(s, { op_id: 'o2', kind: 'list_rename', list_id: 'l9', name: 'Home' });
		expect(s.lists.get('l9')?.name).toBe('Home');

		s.tasks.set('inside', task('inside', { list_id: 'l9' }));
		s = applyOpToMaps(s, { op_id: 'o3', kind: 'list_delete', list_id: 'l9' });
		expect(s.lists.has('l9')).toBe(false);
		expect(s.tasks.has('inside')).toBe(false);
	});

	it('does not mutate the input maps', () => {
		const before = state([], [task('a')]);
		applyOpToMaps(before, { op_id: 'o', kind: 'task_delete', uid: 'a' });
		expect(before.tasks.has('a')).toBe(true);
	});
});
