/**
 * Completion roll-forward for recurring tasks. Port of
 * backend/tasks_api/recurrence.py (dateutil.rrule) onto ical.js.
 *
 * Completing a recurring task does not close it: DUE (and DTSTART, when
 * present) advance to the next occurrence strictly after `max(now, base)`.
 * "After now" skips every occurrence missed while the task sat overdue; the
 * max guard keeps an early completion from re-landing on the current
 * occurrence. The RRULE is preserved verbatim except COUNT, which decrements
 * by the occurrences consumed. An exhausted rule (COUNT spent, UNTIL passed)
 * returns false and the caller completes the task normally.
 *
 * All-day (DATE) and floating bases compare "now" in the household zone
 * (TASKS_LOCAL_TZ, default Europe/Sofia), never UTC (contract delta v1.1 §F).
 * ical.js has no timezone database of its own: convert `now` to that zone's
 * wall clock with Intl.DateTimeFormat. Apple writes UNTIL as a UTC date-time
 * even on all-day tasks; align it to the base's domain for computation only.
 */
import type ICAL from "ical.js";

import { notImplemented } from "../not-implemented.server";

// ical.js's default export is an object of classes, not a namespace.
export type IcalRecur = InstanceType<typeof ICAL.Recur>;
export type IcalTime = InstanceType<typeof ICAL.Time>;
export type IcalComponent = InstanceType<typeof ICAL.Component>;

/** An RRULE that cannot be interpreted. Reported as a per-op `error`. */
export class RecurrenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecurrenceError";
	}
}

/**
 * First occurrence strictly after `max(now, base)`; null when exhausted.
 * `localTimezone` is the IANA zone for DATE and floating bases.
 */
export function nextOccurrence(
	recur: IcalRecur,
	base: IcalTime,
	now: Date,
	localTimezone: string,
): IcalTime | null {
	void recur;
	void base;
	void now;
	return notImplemented(`nextOccurrence(${localTimezone})`);
}

/**
 * Advance DUE / DTSTART of `vtodo` (a VTODO component, mutated in place) to
 * the next occurrence. Returns false when the task is not recurring, has no
 * date to roll, or the rule is exhausted; the vtodo is then unchanged.
 */
export function rollForward(
	vtodo: IcalComponent,
	now: Date,
	localTimezone: string,
): boolean {
	void vtodo;
	void now;
	return notImplemented(`rollForward(${localTimezone})`);
}
