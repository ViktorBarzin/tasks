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
import ICAL from "ical.js";

import {
	decodeTime,
	type TimeValue,
	TimeValueError,
	timeProperty,
} from "./ical-time.server";
import {
	ianaOffsetAt,
	type OffsetAt,
	type WallClock,
	wallClockAt,
	wallFromMs,
	wallMs,
	wallToEpoch,
} from "./tz.server";

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
 * Stop iterating after this many occurrences and report the rule as
 * unsupported, rather than spin on a pathological rule (dateutil would
 * iterate for as long as it takes).
 */
const MAX_OCCURRENCES = 500_000;

/** The RFC 5545 recur parts dateutil accepts; anything else is an error. */
const KNOWN_PARTS = new Set([
	"freq",
	"until",
	"count",
	"interval",
	"bysecond",
	"byminute",
	"byhour",
	"byday",
	"bymonthday",
	"byyearday",
	"byweekno",
	"bymonth",
	"bysetpos",
	"wkst",
]);

/**
 * How occurrences compare against "now", mirroring the Python base's
 * naive/aware domain: a DATE or floating base is naive (compared on the
 * household's wall clock), a UTC or TZID base is aware (compared as instants).
 */
type Domain = { kind: "naive" } | { kind: "aware"; offsetAt: OffsetAt };

const UTC_OFFSET: OffsetAt = () => 0;

function domainOf(t: TimeValue): Domain {
	if (t.kind === "utc") return { kind: "aware", offsetAt: UTC_OFFSET };
	if (t.kind === "zone") return { kind: "aware", offsetAt: t.offsetAt };
	return { kind: "naive" };
}

/** An occurrence's (or the base's) position on the domain's time line. */
function keyOf(wall: WallClock, domain: Domain): number {
	const w = wallMs(wall);
	return domain.kind === "naive" ? w : wallToEpoch(w, domain.offsetAt);
}

/**
 * "Now" brought into the base's domain. For a naive base the threshold is a
 * wall-clock question, so it is read in the household zone, never UTC (which
 * near midnight lands on the wrong calendar day; contract delta v1.1 §F).
 */
function nowKey(now: Date, domain: Domain, localTimezone: string): number {
	if (domain.kind === "aware") return now.getTime();
	if (ianaOffsetAt(localTimezone) === null) {
		throw new RecurrenceError(`unknown local time zone ${localTimezone}`);
	}
	return (
		wallMs(wallClockAt(now.getTime(), localTimezone)) + (now.getTime() % 1000)
	);
}

/**
 * UNTIL aligned to the base's domain, for computation only (the stored RRULE
 * is never rewritten except COUNT). Apple writes UNTIL as a UTC date-time even
 * for all-day tasks: against a naive base it becomes the naive UTC wall clock;
 * a naive or DATE UNTIL against an aware base is read as UTC. Both cases reduce
 * to the UNTIL fields read as UTC milliseconds.
 */
function untilKey(recur: IcalRecur): number | null {
	const until = recur.until;
	if (until === null || until === undefined) return null;
	return wallMs({
		year: until.year,
		month: until.month,
		day: until.day,
		hour: until.isDate ? 0 : until.hour,
		minute: until.isDate ? 0 : until.minute,
		second: until.isDate ? 0 : until.second,
	});
}

interface Walk {
	/** First occurrence strictly after the threshold, or null when exhausted. */
	next: WallClock | null;
	/** Occurrences in [base, next): the ones a roll to `next` consumes. */
	consumed: number;
}

/**
 * Walk the rule from `base` (dateutil semantics: DTSTART counts only when it
 * matches the rule; UNTIL is inclusive) up to the first occurrence after
 * `threshold`.
 */
function walk(
	recur: IcalRecur,
	base: WallClock,
	domain: Domain,
	threshold: number,
): Walk {
	const until = untilKey(recur);
	const rule = recur.clone();
	rule.until = null;
	const baseKey = keyOf(base, domain);
	let consumed = 0;
	try {
		const iterator = rule.iterator(
			ICAL.Time.fromData({ ...base, isDate: false }),
		);
		for (let i = 0; i < MAX_OCCURRENCES; i++) {
			const occurrence = iterator.next();
			if (!occurrence) return { next: null, consumed };
			const wall: WallClock = {
				year: occurrence.year,
				month: occurrence.month,
				day: occurrence.day,
				hour: occurrence.hour,
				minute: occurrence.minute,
				second: occurrence.second,
			};
			const key = keyOf(wall, domain);
			if (until !== null && key > until) return { next: null, consumed };
			if (key > threshold) return { next: wall, consumed };
			if (key >= baseKey) consumed += 1;
		}
	} catch (err) {
		if (err instanceof RecurrenceError) throw err;
		throw new RecurrenceError(
			`unsupported RRULE ${recur.toString()}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	throw new RecurrenceError(
		`unsupported RRULE ${recur.toString()}: no next occurrence within ${MAX_OCCURRENCES} occurrences`,
	);
}

/** The domain of an ical.js Time (used by the public nextOccurrence). */
function domainOfTime(base: IcalTime): Domain {
	if (base.isDate) return { kind: "naive" };
	if (base.zone?.tzid === "UTC") return { kind: "aware", offsetAt: UTC_OFFSET };
	// ical.js keeps an unregistered TZID on the Time as `timezone`.
	const tzid = (base as IcalTime & { timezone?: unknown }).timezone;
	const offsetAt = typeof tzid === "string" ? ianaOffsetAt(tzid) : null;
	return offsetAt === null ? { kind: "naive" } : { kind: "aware", offsetAt };
}

function wallOfTime(t: IcalTime): WallClock {
	return {
		year: t.year,
		month: t.month,
		day: t.day,
		hour: t.isDate ? 0 : t.hour,
		minute: t.isDate ? 0 : t.minute,
		second: t.isDate ? 0 : t.second,
	};
}

/**
 * First occurrence strictly after `max(now, base)`; null when exhausted.
 * `localTimezone` is the IANA zone for DATE and floating bases. The result
 * is a DATE-TIME on the base's wall clock (UTC when the base is UTC).
 */
export function nextOccurrence(
	recur: IcalRecur,
	base: IcalTime,
	now: Date,
	localTimezone: string,
): IcalTime | null {
	const domain = domainOfTime(base);
	const wall = wallOfTime(base);
	const threshold = Math.max(
		nowKey(now, domain, localTimezone),
		keyOf(wall, domain),
	);
	const { next } = walk(recur, wall, domain, threshold);
	if (next === null) return null;
	const time = ICAL.Time.fromData({ ...next, isDate: false });
	if (base.zone?.tzid === "UTC") time.zone = ICAL.Timezone.utcTimezone;
	return time;
}

/** Reject parts dateutil would refuse (ical.js keeps them in jCal but ignores them). */
function checkRule(raw: unknown): void {
	if (typeof raw !== "object" || raw === null) {
		throw new RecurrenceError("RRULE has no value");
	}
	const keys = Object.keys(raw);
	const unknown = keys.filter((k) => !KNOWN_PARTS.has(k.toLowerCase()));
	if (unknown.length > 0) {
		throw new RecurrenceError(
			`unsupported RRULE: unknown part(s) ${unknown.map((k) => k.toUpperCase()).join(", ")}`,
		);
	}
	if (!keys.some((k) => k.toLowerCase() === "freq")) {
		throw new RecurrenceError("unsupported RRULE: FREQ is required");
	}
}

function decodeOrRecurrenceError(
	vtodo: IcalComponent,
	name: string,
): TimeValue {
	const prop = vtodo.getFirstProperty(name);
	if (prop === null) throw new RecurrenceError(`no ${name.toUpperCase()}`);
	try {
		return decodeTime(prop, vtodo);
	} catch (err) {
		if (err instanceof TimeValueError) {
			throw new RecurrenceError(
				`unsupported recurrence base value: ${err.message}`,
			);
		}
		throw err;
	}
}

/** `wall` written in the form of `like`: DATE stays DATE, zones are kept. */
function inFormOf(like: TimeValue, wall: WallClock): TimeValue {
	if (like.kind === "date") {
		return {
			kind: "date",
			wall: { ...wall, hour: 0, minute: 0, second: 0 },
		};
	}
	return { ...like, wall };
}

function setProp(vtodo: IcalComponent, name: string, value: TimeValue): void {
	vtodo.removeAllProperties(name);
	vtodo.addProperty(timeProperty(name, value));
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
	const rrules = vtodo.getAllProperties("rrule");
	// icalendar returns a list for repeated RRULEs, which Python's
	// isinstance(recur, vRecur) check treats as not recurring.
	const rrule = rrules.length === 1 ? rrules[0] : undefined;
	if (rrule === undefined) return false;

	const hasStart = vtodo.hasProperty("dtstart");
	const hasDue = vtodo.hasProperty("due");
	if (!hasStart && !hasDue) return false;

	const rawRule = rrule.jCal[3] as Record<string, unknown> | undefined;
	checkRule(rawRule);
	let recur: IcalRecur;
	try {
		recur = rrule.getFirstValue() as IcalRecur;
	} catch (err) {
		throw new RecurrenceError(
			`unsupported RRULE: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const base = decodeOrRecurrenceError(vtodo, hasStart ? "dtstart" : "due");
	const domain = domainOf(base);
	const baseKey = keyOf(base.wall, domain);
	const threshold = Math.max(nowKey(now, domain, localTimezone), baseKey);
	const { next, consumed } = walk(recur, base.wall, domain, threshold);
	if (next === null) return false;

	let due: TimeValue | null = null;
	if (hasStart && hasDue) {
		due = decodeOrRecurrenceError(vtodo, "due");
		if (domainOf(due).kind !== domain.kind) {
			// Python: "can't subtract offset-naive and offset-aware datetimes".
			throw new RecurrenceError(
				"DTSTART and DUE mix floating/all-day and zoned values",
			);
		}
	}

	if (rawRule && typeof rawRule.count === "number") {
		// next exists, so at least one occurrence remains: never below 1.
		// Mutating the jCal value in place keeps the other parts verbatim.
		rawRule.count = rawRule.count - consumed;
	}

	if (due !== null) {
		// Python subtracts aware datetimes that share a tzinfo object (the same
		// TZID) on the wall clock, and others as instants.
		const sameZone =
			(base.kind === "zone" && due.kind === "zone" && base.tzid === due.tzid) ||
			domain.kind === "naive";
		const duration = sameZone
			? wallMs(due.wall) - wallMs(base.wall)
			: keyOf(due.wall, domainOf(due)) - baseKey;
		setProp(vtodo, "dtstart", inFormOf(base, next));
		const dueWall = wallFromMs(wallMs(next) + duration);
		// Python adds the duration to the base-zoned next occurrence, then
		// writes a date when DUE was a date and a datetime otherwise.
		setProp(
			vtodo,
			"due",
			due.kind === "date"
				? inFormOf(due, dueWall)
				: base.kind === "date"
					? { kind: "floating", wall: dueWall }
					: inFormOf(base, dueWall),
		);
	} else {
		setProp(vtodo, hasStart ? "dtstart" : "due", inFormOf(base, next));
	}
	return true;
}
