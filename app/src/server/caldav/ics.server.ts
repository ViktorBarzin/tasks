/**
 * VTODO <-> Task mapping. Port of backend/tasks_api/ics_mapper.py on ical.js.
 *
 * The one hard rule: parse-modify-serialize, never template-regenerate. Every
 * transform parses the stored ICS, touches only the properties the op names
 * (plus SEQUENCE / DTSTAMP / LAST-MODIFIED bookkeeping) and re-serialises:
 * VALARM, RRULE, X-APPLE-*, CREATED and anything else Apple wrote ride along
 * untouched. The Python golden-file tests assert that (unfolded); port them.
 *
 * | Task field | ICS                                   |
 * |------------|---------------------------------------|
 * | title      | SUMMARY                               |
 * | notes      | DESCRIPTION                           |
 * | due        | DUE (DATE or DATE-TIME)               |
 * | priority   | PRIORITY 0/9/5/1 (Apple mapping)      |
 * | sort_order | X-APPLE-SORT-ORDER (signed int, text) |
 * | completed  | STATUS / COMPLETED / PERCENT-COMPLETE |
 * | uid        | UID                                   |
 *
 * Wire strings must match Python's `isoformat()`: `due` is `2026-07-03` for a
 * DATE, `2026-07-03T09:00:00+00:00` for a UTC DATE-TIME (never `Z`),
 * `2026-07-03T09:00:00` for a floating one, and the zone's offset for a
 * TZID one. `completed_at` likewise.
 */
import type { MutableTaskField, Priority, TaskFields } from "#/shared/contract";
import { notImplemented } from "../not-implemented.server";

export const PRIORITY_NONE = 0;
export const PRIORITY_HIGH = 1;
export const PRIORITY_MEDIUM = 5;
export const PRIORITY_LOW = 9;

export const PRODID = "-//viktorbarzin//tasks//EN";

/** Apple's manual-order property (contract delta v1.3): a signed integer. */
export const SORT_ORDER_PROP = "X-APPLE-SORT-ORDER";

/** Task fields an op may set via task_create / task_update. */
export const MUTABLE_FIELDS: ReadonlySet<MutableTaskField> = new Set([
	"title",
	"notes",
	"due",
	"due_has_time",
	"priority",
	"sort_order",
]);

/** ICS content or op field values that cannot be mapped. Reported as a per-op `error`. */
export class MapperError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MapperError";
	}
}

/** The Task view of one VTODO; list_id and href attach at the sync layer. */
export interface ParsedTask {
	uid: string;
	title: string;
	notes: string;
	due: string | null;
	due_has_time: boolean;
	priority: Priority;
	sort_order: number | null;
	completed: boolean;
	completed_at: string | null;
	recurring: boolean;
}

/**
 * The op's task fields, as they arrived on the wire: values are unvalidated
 * (`unknown`) and the mapper validates each one, raising MapperError.
 */
export type OpTaskFields = Partial<Record<keyof TaskFields, unknown>>;

/** RFC 5545 PRIORITY 0-9 to the app's four levels: 1-4 High, 5 Medium, 6-9 Low, else None. */
export function normalizePriority(raw: number): Priority {
	return notImplemented(`normalizePriority(${raw})`);
}

/** Map one CalDAV object to a Task; null when it holds no VTODO. Unparseable ICS: MapperError. */
export function parseTask(ics: string): ParsedTask | null {
	void ics;
	return notImplemented("parseTask");
}

/** A fresh VCALENDAR + VTODO for task_create (the only place that templates). */
export function buildVtodo(
	uid: string,
	fields: OpTaskFields,
	now: Date,
): string {
	void fields;
	void now;
	return notImplemented(`buildVtodo(${uid})`);
}

/** task_update: set exactly the fields present in the op, preserve the rest. */
export function applyFields(
	ics: string,
	fields: OpTaskFields,
	now: Date,
): string {
	void ics;
	void fields;
	void now;
	return notImplemented("applyFields");
}

/**
 * task_complete: completion, or roll-forward for a recurring task. The
 * roll-forward base is the client's `completedAt`, not replay-time `now`
 * (contract delta v1.1 §C). An exhausted rule completes normally.
 */
export function applyComplete(
	ics: string,
	now: Date,
	completedAt?: Date | null,
): string {
	void ics;
	void now;
	void completedAt;
	return notImplemented("applyComplete");
}

/** task_uncomplete: back to NEEDS-ACTION, completion stamps removed. */
export function applyUncomplete(ics: string, now: Date): string {
	void ics;
	void now;
	return notImplemented("applyUncomplete");
}
