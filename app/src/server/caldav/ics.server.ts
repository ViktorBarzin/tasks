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
import ICAL from "ical.js";

import type { MutableTaskField, Priority, TaskFields } from "#/shared/contract";
import { getSettings } from "../config.server";
import {
	decodeTime,
	type IcalComponent,
	type IcalProperty,
	type TimeValue,
	TimeValueError,
	timeIso,
	timeProperty,
	utcValue,
} from "./ical-time.server";
import { rollForward } from "./recurrence.server";
import { wallFromMs } from "./tz.server";

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
 * (`unknown`) and the mapper validates each one, raising MapperError. Keys
 * outside MUTABLE_FIELDS are rejected at runtime too.
 */
export type OpTaskFields = Partial<Record<keyof TaskFields, unknown>>;

// ---------------------------------------------------------------- parsing

const RECUR_LINE = /^(RRULE|EXRULE)((?:;[^:]*)?):(.*)$/i;

/** Holds an RRULE ical.js cannot parse, so a read can still show the task. */
const UNPARSED_RRULE = "X-TASKS-UNPARSED-RRULE";

/** The ICS with folded lines joined and each line passed through `map`. */
function mapLines(ics: string, map: (line: string) => string): string {
	return ics
		.replace(/\r?\n[ \t]/g, "")
		.split(/\r?\n/)
		.map(map)
		.join("\r\n");
}

/**
 * RRULE / EXRULE values upper-cased. RFC 5545 recur values are
 * case-insensitive and icalendar accepted `freq=daily`; ical.js does not.
 */
function upperCaseRecurValues(ics: string): string {
	return mapLines(ics, (line) => {
		const m = RECUR_LINE.exec(line);
		return m ? `${m[1]}${m[2]}:${(m[3] ?? "").toUpperCase()}` : line;
	});
}

/** RRULE lines renamed to an X- property, which ical.js keeps as text. */
function quarantineRrules(ics: string): string {
	return mapLines(ics, (line) => {
		const m = RECUR_LINE.exec(line);
		return m && m[1]?.toUpperCase() === "RRULE"
			? `${UNPARSED_RRULE}${m[2]}:${m[3]}`
			: line;
	});
}

function parseJcal(ics: string): unknown {
	try {
		return ICAL.parse(ics);
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * Calendar.from_ical: exactly one top-level component, else MapperError.
 *
 * Recur values ical.js rejects are retried upper-cased (as icalendar read
 * them). With `forRead`, an RRULE that still does not parse is kept as an
 * X- property, so sync can show the task as recurring, as icalendar's lenient
 * parse did; writes still fail on it (MapperError), so a broken rule is never
 * dropped from the stored object.
 */
function parseComponent(ics: string, forRead = false): IcalComponent {
	let jcal = parseJcal(ics);
	if (jcal instanceof Error) {
		const upper = upperCaseRecurValues(ics);
		const retried = parseJcal(upper);
		if (!(retried instanceof Error)) jcal = retried;
		else if (forRead) {
			const quarantined = parseJcal(quarantineRrules(upper));
			if (!(quarantined instanceof Error)) jcal = quarantined;
		}
	}
	if (jcal instanceof Error) {
		throw new MapperError(`unparseable ICS: ${jcal.message}`);
	}
	if (!Array.isArray(jcal) || jcal.length === 0) {
		throw new MapperError("unparseable ICS: no component found");
	}
	if (typeof jcal[0] !== "string") {
		throw new MapperError(
			"unparseable ICS: found multiple components where only one is allowed",
		);
	}
	return new ICAL.Component(jcal);
}

/** Every VTODO in the tree, root included (icalendar's walk("VTODO")). */
function walkTodos(component: IcalComponent): IcalComponent[] {
	const out: IcalComponent[] = [];
	const visit = (c: IcalComponent) => {
		if (c.name === "vtodo") out.push(c);
		for (const sub of c.getAllSubcomponents()) visit(sub);
	};
	visit(component);
	return out;
}

/** The master VTODO of an object: the first without a RECURRENCE-ID. */
function masterTodo(cal: IcalComponent): IcalComponent | null {
	const todos = walkTodos(cal);
	return todos.find((t) => !t.hasProperty("recurrence-id")) ?? todos[0] ?? null;
}

function parseCalendar(ics: string): [IcalComponent, IcalComponent] {
	const cal = parseComponent(ics);
	const todo = masterTodo(cal);
	if (todo === null) throw new MapperError("object contains no VTODO");
	return [cal, todo];
}

function serialize(cal: IcalComponent): string {
	return `${cal.toString()}\r\n`;
}

/** str() of a property's first value, "" when absent. */
function textValue(todo: IcalComponent, name: string): string {
	const value = todo.getFirstPropertyValue(name.toLowerCase());
	return value === null || value === undefined ? "" : String(value);
}

/** Python's int() of a string: optional sign, digits, `_` between digits. */
function pythonInt(raw: string): number | null {
	const text = raw.trim();
	if (!/^[+-]?\d+(_\d+)*$/.test(text)) return null;
	const value = Number(text.replace(/_/g, ""));
	return Number.isSafeInteger(value) ? value : null;
}

/** An INTEGER property's value; `fallback` when absent; MapperError on garbage. */
function integerValue(
	todo: IcalComponent,
	name: string,
	fallback: number,
): number {
	const prop = todo.getFirstProperty(name.toLowerCase());
	if (prop === null) return fallback;
	const raw = prop.jCal[3];
	const value =
		typeof raw === "number" && Number.isSafeInteger(raw)
			? raw
			: pythonInt(String(raw ?? ""));
	if (value === null) {
		throw new MapperError(
			`unparseable ICS: Expected int, got: ${String(raw ?? "")}`,
		);
	}
	return value;
}

function decodeTimeOrMapperError(
	prop: IcalProperty,
	todo: IcalComponent,
): TimeValue {
	try {
		return decodeTime(prop, todo);
	} catch (err) {
		if (err instanceof TimeValueError) {
			throw new MapperError(`unparseable ICS: ${err.message}`);
		}
		throw err;
	}
}

/** RFC 5545 PRIORITY 0-9 to the app's four levels: 1-4 High, 5 Medium, 6-9 Low, else None. */
export function normalizePriority(raw: number): Priority {
	if (raw >= 1 && raw <= 4) return PRIORITY_HIGH;
	if (raw === 5) return PRIORITY_MEDIUM;
	if (raw >= 6 && raw <= 9) return PRIORITY_LOW;
	return PRIORITY_NONE;
}

function decodeDue(todo: IcalComponent): [string | null, boolean] {
	const prop = todo.getFirstProperty("due");
	if (prop === null) return [null, false];
	const value = decodeTimeOrMapperError(prop, todo);
	return [timeIso(value), value.kind !== "date"];
}

/**
 * X-APPLE-SORT-ORDER as an integer; absent or unparseable means null. Reads
 * are tolerant (another client may have written garbage); only our own
 * writes are validated strictly.
 */
function decodeSortOrder(todo: IcalComponent): number | null {
	const prop = todo.getFirstProperty(SORT_ORDER_PROP.toLowerCase());
	if (prop === null) return null;
	return pythonInt(String(prop.getFirstValue() ?? ""));
}

function decodeCompleted(todo: IcalComponent): [boolean, string | null] {
	let completedAt: string | null = null;
	const prop = todo.getFirstProperty("completed");
	if (prop !== null) {
		const stamp = decodeTimeOrMapperError(prop, todo);
		if (stamp.kind !== "date") completedAt = timeIso(stamp);
	}
	const status = textValue(todo, "STATUS").toUpperCase();
	return [status === "COMPLETED" || completedAt !== null, completedAt];
}

/** Map one CalDAV object to a Task; null when it holds no VTODO. Unparseable ICS: MapperError. */
export function parseTask(ics: string): ParsedTask | null {
	const cal = parseComponent(ics, true);
	const todo = masterTodo(cal);
	if (todo === null) return null;
	const [due, dueHasTime] = decodeDue(todo);
	const [completed, completedAt] = decodeCompleted(todo);
	return {
		uid: textValue(todo, "UID"),
		title: textValue(todo, "SUMMARY"),
		notes: textValue(todo, "DESCRIPTION"),
		due,
		due_has_time: dueHasTime,
		priority: normalizePriority(integerValue(todo, "PRIORITY", 0)),
		sort_order: decodeSortOrder(todo),
		completed,
		completed_at: completedAt,
		recurring:
			todo.hasProperty("rrule") ||
			todo.hasProperty(UNPARSED_RRULE.toLowerCase()),
	};
}

// ---------------------------------------------------------------- writing

/** Python's str() for the JSON values an op can carry. */
function pyStr(value: unknown): string {
	if (value === null || value === undefined) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return JSON.stringify(value);
}

/** Python truthiness for JSON values ([] and {} are falsy). */
function pyTruthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object" && value !== null) {
		return Object.keys(value).length > 0;
	}
	return Boolean(value);
}

/** Whether an ISO due string carries a time of day (`T` or space separator). */
function dueStringHasTime(due: string): boolean {
	return due.includes("T") || due.includes(" ");
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$|^(\d{4})(\d{2})(\d{2})$/;
const ISO_TIME =
	/^(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d+)?)?)?)?$/;

/** YYYY-MM-DD or YYYYMMDD as [year, month, day]. */
function isoDate(text: string): [number, number, number] | null {
	const m = ISO_DATE.exec(text);
	if (m === null) return null;
	const at = (i: number) => Number(m[i] ?? m[i + 3]);
	return [at(1), at(2), at(3)];
}

function checkedWall(
	y: number,
	mo: number,
	d: number,
	h = 0,
	mi = 0,
	s = 0,
): number | null {
	const ms = Date.UTC(y, mo - 1, d, h, mi, s);
	const back = new Date(ms);
	if (
		back.getUTCFullYear() !== y ||
		back.getUTCMonth() !== mo - 1 ||
		back.getUTCDate() !== d ||
		back.getUTCHours() !== h ||
		back.getUTCMinutes() !== mi ||
		back.getUTCSeconds() !== s
	) {
		return null;
	}
	return ms;
}

function parseOffsetMs(raw: string): number {
	if (raw === "Z") return 0;
	const sign = raw.startsWith("-") ? -1 : 1;
	const digits = raw.slice(1).replace(/:/g, "");
	const hh = Number(digits.slice(0, 2));
	const mm = Number(digits.slice(2, 4) || 0);
	const ss = Number.parseFloat(digits.slice(4) || "0");
	if (hh > 23 || mm > 59 || ss >= 60) throw new Error("offset out of range");
	return sign * ((hh * 60 + mm) * 60 + ss) * 1000;
}

/**
 * An op's ISO due string to the ICS value, following Python's
 * date.fromisoformat / datetime.fromisoformat: dates stay dates, aware
 * datetimes are written as UTC, naive ones stay floating.
 */
function parseDueValue(due: string, dueHasTime: boolean): TimeValue {
	const invalid = () =>
		new MapperError(`invalid due value '${due}': Invalid isoformat string`);
	if (!dueHasTime) {
		const ymd = isoDate(due);
		const ms = ymd && checkedWall(...ymd);
		if (ms === null || ms === undefined) throw invalid();
		return { kind: "date", wall: wallFromMs(ms) };
	}
	// datetime.fromisoformat: a date, optionally followed by ANY single
	// separator character and a time.
	const datePart = /^\d{4}-\d{2}-\d{2}|^\d{8}/.exec(due)?.[0];
	if (datePart === undefined) throw invalid();
	const dm = isoDate(datePart);
	if (dm === null) throw invalid();
	const rest = due.slice(datePart.length);
	let h = 0;
	let mi = 0;
	let s = 0;
	let offsetMs: number | null = null;
	if (rest !== "") {
		const tm = ISO_TIME.exec([...rest].slice(1).join(""));
		if (tm === null || [...rest].length < 2) throw invalid();
		h = Number(tm[1]);
		mi = Number(tm[2] ?? 0);
		s = Number(tm[3] ?? 0);
		if (tm[5] !== undefined) {
			try {
				offsetMs = parseOffsetMs(tm[5]);
			} catch {
				throw invalid();
			}
		}
	}
	const ms = checkedWall(...dm, h, mi, s);
	if (ms === null) throw invalid();
	if (offsetMs === null) return { kind: "floating", wall: wallFromMs(ms) };
	// Aware: the correct instant in UTC, no VTIMEZONE needed.
	return { kind: "utc", wall: wallFromMs(ms - offsetMs) };
}

/** Pop every `name` property and append a fresh one (icalendar's pop + add). */
function setProp(todo: IcalComponent, prop: IcalProperty): void {
	todo.removeAllProperties(prop.name);
	todo.addProperty(prop);
}

function setValue(todo: IcalComponent, name: string, value: string | number) {
	const prop = new ICAL.Property(name.toLowerCase());
	prop.setValue(value);
	setProp(todo, prop);
}

/** Bookkeeping every rewrite performs: SEQUENCE bump and fresh stamps. */
function touch(todo: IcalComponent, now: Date): void {
	const sequence = integerValue(todo, "SEQUENCE", 0);
	setValue(todo, "SEQUENCE", sequence + 1);
	setProp(todo, timeProperty("DTSTAMP", utcValue(now)));
	setProp(todo, timeProperty("LAST-MODIFIED", utcValue(now)));
}

function applyDue(
	todo: IcalComponent,
	due: string | null,
	dueHasTime: boolean,
): void {
	if (due === null) {
		// Clear the deadline; DTSTART (the RRULE anchor, when present) stays.
		todo.removeAllProperties("due");
		return;
	}
	const value = parseDueValue(due, dueHasTime);
	setProp(todo, timeProperty("DUE", value));
	if (todo.hasProperty("dtstart")) {
		// Reminders-style tasks keep DTSTART == DUE; RFC 5545 requires
		// DTSTART <= DUE, so the anchor moves with the deadline.
		setProp(todo, timeProperty("DTSTART", value));
	}
}

const pyRepr = (value: unknown) =>
	typeof value === "string" ? `'${value}'` : pyStr(value);

function applyFieldsToTodo(todo: IcalComponent, fields: OpTaskFields): void {
	const present = (key: string) =>
		Object.hasOwn(fields, key) &&
		(fields as Record<string, unknown>)[key] !== undefined;
	const get = (key: keyof TaskFields) =>
		present(key) ? (fields as Record<string, unknown>)[key] : undefined;

	const unknown = Object.keys(fields)
		.filter((k) => present(k) && !MUTABLE_FIELDS.has(k as MutableTaskField))
		.sort();
	if (unknown.length > 0) {
		throw new MapperError(
			`unknown task fields: [${unknown.map((k) => `'${k}'`).join(", ")}]`,
		);
	}
	if (present("title")) setValue(todo, "SUMMARY", pyStr(get("title")));
	if (present("notes")) {
		const notes = pyStr(get("notes"));
		if (notes) setValue(todo, "DESCRIPTION", notes);
		else todo.removeAllProperties("description");
	}
	if (present("due") || present("due_has_time")) {
		const due = get("due") ?? null;
		if (due !== null && typeof due !== "string") {
			throw new MapperError(
				`invalid due value ${pyRepr(due)}: expected ISO string or null`,
			);
		}
		let hasTime = pyTruthy(get("due_has_time") ?? false);
		// Guard inconsistent due fields (SYNC-12 / contract L): due and
		// due_has_time travel together. Reject a flag with no value; normalise
		// a date-time value that arrived without the flag.
		if (due === null) {
			if (!present("due")) {
				throw new MapperError(
					"due_has_time was sent without a due value; send both together",
				);
			}
			if (hasTime) {
				throw new MapperError("cannot clear due while due_has_time is true");
			}
			applyDue(todo, null, false);
		} else {
			if (!hasTime && dueStringHasTime(due)) hasTime = true;
			applyDue(todo, due, hasTime);
		}
	}
	if (present("priority")) {
		const priority = get("priority");
		if (
			typeof priority !== "number" ||
			!Number.isInteger(priority) ||
			![PRIORITY_NONE, PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW].includes(
				priority,
			)
		) {
			throw new MapperError(
				`invalid priority ${pyRepr(priority)}: must be one of 0, 1, 5, 9`,
			);
		}
		if (priority === PRIORITY_NONE) todo.removeAllProperties("priority");
		else setValue(todo, "PRIORITY", priority);
	}
	if (present("sort_order")) {
		const sortOrder = get("sort_order");
		if (sortOrder === null) {
			todo.removeAllProperties(SORT_ORDER_PROP.toLowerCase());
		} else if (
			typeof sortOrder !== "number" ||
			!Number.isSafeInteger(sortOrder)
		) {
			throw new MapperError(
				`invalid sort_order ${pyRepr(sortOrder)}: must be an integer or null`,
			);
		} else {
			// Written as plain text, matching Apple's own bare integer output.
			setValue(todo, SORT_ORDER_PROP, String(sortOrder));
		}
	}
}

/** A fresh VCALENDAR + VTODO for task_create (the only place that templates). */
export function buildVtodo(
	uid: string,
	fields: OpTaskFields,
	now: Date,
): string {
	const cal = new ICAL.Component("vcalendar");
	cal.addPropertyWithValue("version", "2.0");
	cal.addPropertyWithValue("prodid", PRODID);
	const todo = new ICAL.Component("vtodo");
	todo.addPropertyWithValue("uid", uid);
	todo.addPropertyWithValue("summary", "");
	todo.addProperty(timeProperty("CREATED", utcValue(now)));
	todo.addProperty(timeProperty("DTSTAMP", utcValue(now)));
	todo.addProperty(timeProperty("LAST-MODIFIED", utcValue(now)));
	todo.addPropertyWithValue("status", "NEEDS-ACTION");
	todo.addPropertyWithValue("sequence", 0);
	applyFieldsToTodo(todo, fields);
	cal.addSubcomponent(todo);
	return serialize(cal);
}

/** task_update: set exactly the fields present in the op, preserve the rest. */
export function applyFields(
	ics: string,
	fields: OpTaskFields,
	now: Date,
): string {
	const [cal, todo] = parseCalendar(ics);
	applyFieldsToTodo(todo, fields);
	touch(todo, now);
	return serialize(cal);
}

/**
 * task_complete: completion, or roll-forward for a recurring task. A live
 * RRULE with a next occurrence advances DUE/DTSTART and leaves the task open;
 * an exhausted rule completes normally. The roll-forward base is the client's
 * `completedAt` (the instant the user completed it), not replay-time `now`,
 * so a delayed replay lands on the occurrence after the completion (contract
 * delta v1.1 §C). All-day rules roll in TASKS_LOCAL_TZ. RecurrenceError
 * propagates for a rule that cannot be interpreted.
 */
export function applyComplete(
	ics: string,
	now: Date,
	completedAt?: Date | null,
): string {
	const [cal, todo] = parseCalendar(ics);
	const completionInstant = completedAt ?? now;
	if (!rollForward(todo, completionInstant, getSettings().localTimezone)) {
		setValue(todo, "STATUS", "COMPLETED");
		setProp(todo, timeProperty("COMPLETED", utcValue(completionInstant)));
		setValue(todo, "PERCENT-COMPLETE", 100);
	}
	touch(todo, now);
	return serialize(cal);
}

/** task_uncomplete: back to NEEDS-ACTION, completion stamps removed. */
export function applyUncomplete(ics: string, now: Date): string {
	const [cal, todo] = parseCalendar(ics);
	setValue(todo, "STATUS", "NEEDS-ACTION");
	todo.removeAllProperties("completed");
	todo.removeAllProperties("percent-complete");
	touch(todo, now);
	return serialize(cal);
}
