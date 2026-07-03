/**
 * Due-date helpers. A Task's `due` is either a local date (`YYYY-MM-DD`,
 * `due_has_time: false`) or an ISO datetime (`due_has_time: true`). All
 * comparisons happen in the device's local time — a household tasks app has
 * no other sensible zone. Every function takes `now` for testability.
 */
import type { Task } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/** Local YYYY-MM-DD of a Date. */
export function todayKey(now: Date = new Date()): string {
	return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Local day (YYYY-MM-DD) a due string falls on. */
export function dayKeyOf(due: string): string {
	if (!due.includes('T')) return due.slice(0, 10);
	const d = new Date(due);
	return todayKey(d);
}

/** The due as a comparable local timestamp; all-day dues sort at local midnight. */
export function dueTime(task: Pick<Task, 'due' | 'due_has_time'>): number | null {
	if (!task.due) return null;
	if (task.due_has_time && task.due.includes('T')) return new Date(task.due).getTime();
	const [y, m, d] = task.due.slice(0, 10).split('-').map(Number);
	if (!y || !m || !d) return null;
	return new Date(y, m - 1, d).getTime();
}

/** Overdue: a timed due whose moment passed, or a dated due before today. */
export function isOverdue(task: Task, now: Date = new Date()): boolean {
	if (task.completed || !task.due) return false;
	if (task.due_has_time && task.due.includes('T')) return new Date(task.due).getTime() < now.getTime();
	return dayKeyOf(task.due) < todayKey(now);
}

/** Today Smart View membership: due today or overdue (Reminders semantics). */
export function isDueToday(task: Task, now: Date = new Date()): boolean {
	if (!task.due) return false;
	return dayKeyOf(task.due) <= todayKey(now);
}

/**
 * Sort by due: earlier days first; within a day all-day before timed; tasks
 * without a due last.
 */
export function compareDue(a: Task, b: Task): number {
	const ta = dueTime(a);
	const tb = dueTime(b);
	if (ta === null && tb === null) return 0;
	if (ta === null) return 1;
	if (tb === null) return -1;
	const dayA = dayKeyOf(a.due as string);
	const dayB = dayKeyOf(b.due as string);
	if (dayA !== dayB) return dayA < dayB ? -1 : 1;
	// Same day: all-day (no time) first, then by time.
	const allDayA = !a.due_has_time;
	const allDayB = !b.due_has_time;
	if (allDayA !== allDayB) return allDayA ? -1 : 1;
	return ta - tb;
}

function relativeDayName(key: string, now: Date): string | null {
	const today = todayKey(now);
	if (key === today) return 'Today';
	const tomorrow = todayKey(new Date(now.getTime() + DAY_MS));
	if (key === tomorrow) return 'Tomorrow';
	const yesterday = todayKey(new Date(now.getTime() - DAY_MS));
	if (key === yesterday) return 'Yesterday';
	return null;
}

function keyToDate(key: string): Date {
	const [y, m, d] = key.split('-').map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function spellDate(key: string, now: Date): string {
	const d = keyToDate(key);
	const sameYear = d.getFullYear() === now.getFullYear();
	return d.toLocaleDateString('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/** Compact chip label: "Today", "Tomorrow, 14:05", "Thu, 9 Jul"… */
export function formatDueChip(task: Task, now: Date = new Date()): string {
	if (!task.due) return '';
	const key = dayKeyOf(task.due);
	const day = relativeDayName(key, now) ?? spellDate(key, now);
	if (task.due_has_time && task.due.includes('T')) {
		const d = new Date(task.due);
		return `${day}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	}
	return day;
}

/** Section heading for a Scheduled-view day group. */
export function formatDayHeading(key: string, now: Date = new Date()): string {
	return relativeDayName(key, now) ?? spellDate(key, now);
}

/** Split a due into <input type=date> / <input type=time> values. */
export function dueToInputs(task: Pick<Task, 'due' | 'due_has_time'>): { date: string; time: string } {
	if (!task.due) return { date: '', time: '' };
	if (task.due_has_time && task.due.includes('T')) {
		const d = new Date(task.due);
		return {
			date: todayKey(d),
			time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
		};
	}
	return { date: task.due.slice(0, 10), time: '' };
}

/** Combine date/time inputs back into a due string (local, no zone suffix). */
export function inputsToDue(date: string, time: string): { due: string | null; due_has_time: boolean } {
	if (!date) return { due: null, due_has_time: false };
	if (!time) return { due: date, due_has_time: false };
	return { due: `${date}T${time}:00`, due_has_time: true };
}
