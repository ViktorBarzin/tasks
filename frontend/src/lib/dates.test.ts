import { describe, expect, it } from 'vitest';

import {
	compareDue,
	dayKeyOf,
	formatDayHeading,
	formatDueChip,
	isDueToday,
	isOverdue,
	todayKey
} from './dates';
import type { Task } from './types';

/** A fixed "now": Friday 2026-07-03 10:30 local time. */
const NOW = new Date(2026, 6, 3, 10, 30, 0);

function task(due: string | null, due_has_time = false): Task {
	return {
		uid: 'u1',
		list_id: 'l1',
		title: 't',
		notes: '',
		due,
		due_has_time,
		priority: 0,
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: false
	};
}

describe('todayKey / dayKeyOf', () => {
	it('formats local YYYY-MM-DD', () => {
		expect(todayKey(NOW)).toBe('2026-07-03');
	});

	it('keys a date-only due by its own string', () => {
		expect(dayKeyOf('2026-07-09')).toBe('2026-07-09');
	});

	it('keys a datetime due by its local day', () => {
		expect(dayKeyOf('2026-07-09T23:15:00')).toBe('2026-07-09');
	});
});

describe('isOverdue', () => {
	it('date-only: overdue strictly before today', () => {
		expect(isOverdue(task('2026-07-02'), NOW)).toBe(true);
		expect(isOverdue(task('2026-07-03'), NOW)).toBe(false);
		expect(isOverdue(task('2026-07-04'), NOW)).toBe(false);
	});

	it('datetime: overdue when the moment has passed', () => {
		expect(isOverdue(task('2026-07-03T09:00:00', true), NOW)).toBe(true);
		expect(isOverdue(task('2026-07-03T11:00:00', true), NOW)).toBe(false);
	});

	it('no due or completed → never overdue', () => {
		expect(isOverdue(task(null), NOW)).toBe(false);
		expect(isOverdue({ ...task('2026-07-01'), completed: true }, NOW)).toBe(false);
	});
});

describe('isDueToday', () => {
	it('includes due today and overdue (Reminders Today semantics)', () => {
		expect(isDueToday(task('2026-07-03'), NOW)).toBe(true);
		expect(isDueToday(task('2026-06-30'), NOW)).toBe(true);
		expect(isDueToday(task('2026-07-03T23:00:00', true), NOW)).toBe(true);
	});

	it('excludes future and no-due tasks', () => {
		expect(isDueToday(task('2026-07-04'), NOW)).toBe(false);
		expect(isDueToday(task(null), NOW)).toBe(false);
	});
});

describe('compareDue', () => {
	it('orders by day, all-day before timed within a day, no-due last', () => {
		const order = [
			task('2026-07-02T18:00:00', true),
			task('2026-07-03'),
			task('2026-07-03T08:00:00', true),
			task('2026-07-03T14:00:00', true),
			task('2026-07-05'),
			task(null)
		];
		const shuffled = [order[3], order[5], order[0], order[4], order[2], order[1]] as Task[];
		const sorted = [...shuffled].sort(compareDue);
		expect(sorted.map((t) => t.due)).toEqual(order.map((t) => (t as Task).due));
	});
});

describe('formatDueChip', () => {
	it('says Today / Tomorrow / Yesterday', () => {
		expect(formatDueChip(task('2026-07-03'), NOW)).toBe('Today');
		expect(formatDueChip(task('2026-07-04'), NOW)).toBe('Tomorrow');
		expect(formatDueChip(task('2026-07-02'), NOW)).toBe('Yesterday');
	});

	it('appends the time for timed dues', () => {
		expect(formatDueChip(task('2026-07-03T14:05:00', true), NOW)).toBe('Today, 14:05');
	});

	it('spells out other dates', () => {
		expect(formatDueChip(task('2026-07-09'), NOW)).toMatch(/Thu.* 9 Jul/);
		// A different year keeps the year visible.
		expect(formatDueChip(task('2027-01-09'), NOW)).toMatch(/2027/);
	});
});

describe('formatDayHeading', () => {
	it('names today and tomorrow', () => {
		expect(formatDayHeading('2026-07-03', NOW)).toBe('Today');
		expect(formatDayHeading('2026-07-04', NOW)).toBe('Tomorrow');
	});

	it('spells out other days', () => {
		expect(formatDayHeading('2026-07-06', NOW)).toMatch(/Mon.* 6 Jul/);
	});
});
