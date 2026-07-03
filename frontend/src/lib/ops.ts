/**
 * Pure optimistic application of an Op to an in-memory Replica state.
 * Used twice: immediately when the user acts (instant UI), and to re-apply
 * still-queued Ops on top of freshly-folded server state so pending local
 * changes never visually vanish mid-sync. Returns new Maps; never mutates.
 */
import type { Op, Task, TaskList } from './types';

export interface ReplicaState {
	lists: Map<string, TaskList>;
	tasks: Map<string, Task>;
}

export function applyOpToMaps(state: ReplicaState, op: Op): ReplicaState {
	const lists = new Map(state.lists);
	const tasks = new Map(state.tasks);

	switch (op.kind) {
		case 'task_create': {
			// Reapply-after-fold: if the server already delivered this uid, its
			// copy is at least as fresh — keep it.
			if (!tasks.has(op.uid)) {
				tasks.set(op.uid, {
					uid: op.uid,
					list_id: op.list_id,
					title: op.title,
					notes: op.notes,
					due: op.due,
					due_has_time: op.due_has_time,
					priority: op.priority,
					completed: false,
					completed_at: null,
					recurring: false,
					deleted: false
				});
			}
			break;
		}
		case 'task_update': {
			const t = tasks.get(op.uid);
			if (t) {
				tasks.set(op.uid, {
					...t,
					...(op.title !== undefined ? { title: op.title } : {}),
					...(op.notes !== undefined ? { notes: op.notes } : {}),
					...(op.due !== undefined ? { due: op.due } : {}),
					...(op.due_has_time !== undefined ? { due_has_time: op.due_has_time } : {}),
					...(op.priority !== undefined ? { priority: op.priority } : {})
				});
			}
			break;
		}
		case 'task_complete': {
			const t = tasks.get(op.uid);
			// A Recurring Task really rolls its Due forward server-side; locally it
			// shows as done until the next sync delivers the rolled-forward copy.
			if (t) tasks.set(op.uid, { ...t, completed: true, completed_at: op.completed_at });
			break;
		}
		case 'task_uncomplete': {
			const t = tasks.get(op.uid);
			if (t) tasks.set(op.uid, { ...t, completed: false, completed_at: null });
			break;
		}
		case 'task_move': {
			const t = tasks.get(op.uid);
			// list_id is the source hint; the Task rehomes to the destination.
			if (t) tasks.set(op.uid, { ...t, list_id: op.to_list_id });
			break;
		}
		case 'task_delete': {
			tasks.delete(op.uid);
			break;
		}
		case 'list_create': {
			if (!lists.has(op.list_id)) {
				lists.set(op.list_id, { id: op.list_id, name: op.name, deleted: false });
			}
			break;
		}
		case 'list_rename': {
			const l = lists.get(op.list_id);
			if (l) lists.set(op.list_id, { ...l, name: op.name });
			break;
		}
		case 'list_delete': {
			lists.delete(op.list_id);
			for (const [uid, t] of tasks) {
				if (t.list_id === op.list_id) tasks.delete(uid);
			}
			break;
		}
	}
	return { lists, tasks };
}
