/**
 * DATE / DATE-TIME property values for the ICS mapper and recurrence, read
 * and written at the jCal level so ical.js never re-interprets a zone.
 *
 * Python's icalendar decoded these into date, naive datetime (floating),
 * UTC-aware datetime or zoneinfo-aware datetime (TZID); the four `kind`s
 * below are the same four cases. A TZID resolves through Intl (IANA names)
 * or, failing that, a VTIMEZONE in the same calendar; an unresolvable TZID is
 * floating, as icalendar 6 treats it.
 */
import ICAL from "ical.js";

import {
	ianaOffsetAt,
	isoformat,
	type OffsetAt,
	type WallClock,
	wallFromMs,
	wallMs,
	wallToEpoch,
} from "./tz.server";
import { WINDOWS_TO_IANA } from "./windows-zones.server";

export type IcalComponent = InstanceType<typeof ICAL.Component>;
export type IcalProperty = InstanceType<typeof ICAL.Property>;

export type TimeKind =
	| { kind: "date" }
	| { kind: "floating" }
	| { kind: "utc" }
	| { kind: "zone"; tzid: string; offsetAt: OffsetAt };

export type TimeValue = TimeKind & { wall: WallClock };

/** A DATE / DATE-TIME value this module cannot read. */
export class TimeValueError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeValueError";
	}
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)$/;

/** Parse an ical.js jCal date or date-time string into wall-clock fields. */
export function parseJcalTime(
	value: string,
	type: string,
): { wall: WallClock; isDate: boolean; utc: boolean } {
	if (type === "date") {
		const m = DATE_RE.exec(value);
		if (m === null) throw new TimeValueError(`invalid DATE value ${value}`);
		return {
			wall: wallOf(m, false),
			isDate: true,
			utc: false,
		};
	}
	if (type === "date-time") {
		const m = DATE_TIME_RE.exec(value);
		if (m === null)
			throw new TimeValueError(`invalid DATE-TIME value ${value}`);
		return { wall: wallOf(m, true), isDate: false, utc: m[7] === "Z" };
	}
	throw new TimeValueError(`unsupported value type ${type}`);
}

function wallOf(m: RegExpExecArray, hasTime: boolean): WallClock {
	const n = (i: number) => Number(m[i] ?? 0);
	const wall = {
		year: n(1),
		month: n(2),
		day: n(3),
		hour: hasTime ? n(4) : 0,
		minute: hasTime ? n(5) : 0,
		second: hasTime ? n(6) : 0,
	};
	// Reject impossible fields (2026-02-30, 25:00) the way date() would.
	const round = wallFromMs(wallMs(wall));
	if (
		round.year !== wall.year ||
		round.month !== wall.month ||
		round.day !== wall.day ||
		round.hour !== wall.hour ||
		round.minute !== wall.minute ||
		round.second !== wall.second
	) {
		throw new TimeValueError(`invalid date or time ${m[0]}`);
	}
	return wall;
}

function rootOf(component: IcalComponent): IcalComponent {
	let node = component;
	while (node.parent) node = node.parent;
	return node;
}

function vtimezoneOffsetAt(
	component: IcalComponent,
	tzid: string,
): OffsetAt | null {
	const root = rootOf(component);
	const vtz = root
		.getAllSubcomponents("vtimezone")
		.find((tz) => tz.getFirstPropertyValue("tzid") === tzid);
	if (vtz === undefined) return null;
	const zone = new ICAL.Timezone(vtz);
	return (epochMs: number) => {
		const whole = Math.floor(epochMs / 1000) * 1000;
		const local = ICAL.Time.fromJSDate(new Date(whole), true).convertToZone(
			zone,
		);
		return wallMs(local) - whole;
	};
}

/**
 * Resolve a TZID in icalendar 6.3.2's order (timezone/tzp.py `timezone`):
 * the IANA zone (leading/trailing "/" stripped), then a Windows zone name
 * mapped to IANA, then the raw value, then the calendar's own VTIMEZONE.
 */
export function resolveTzid(
	component: IcalComponent,
	tzid: string,
): OffsetAt | null {
	const clean = tzid.replace(/^\/+|\/+$/g, "");
	const windows = Object.hasOwn(WINDOWS_TO_IANA, clean)
		? WINDOWS_TO_IANA[clean]
		: undefined;
	return (
		ianaOffsetAt(clean) ??
		(windows ? ianaOffsetAt(windows) : null) ??
		ianaOffsetAt(tzid) ??
		vtimezoneOffsetAt(component, tzid) ??
		(clean !== tzid ? vtimezoneOffsetAt(component, clean) : null)
	);
}

function tzidOf(prop: IcalProperty): string | null {
	const raw = prop.getParameter("tzid");
	const tzid = Array.isArray(raw) ? raw[0] : raw;
	return typeof tzid === "string" && tzid !== "" ? tzid : null;
}

/** Decode a DATE / DATE-TIME property (first value). */
export function decodeTime(
	prop: IcalProperty,
	component: IcalComponent,
): TimeValue {
	const [, , type, value] = prop.jCal as [string, unknown, string, unknown];
	if (typeof value !== "string") {
		throw new TimeValueError(`${prop.name.toUpperCase()} has no value`);
	}
	const { wall, isDate, utc } = parseJcalTime(value, type);
	if (isDate) return { kind: "date", wall };
	if (utc) return { kind: "utc", wall };
	const tzid = tzidOf(prop);
	if (tzid !== null) {
		const offsetAt = resolveTzid(component, tzid);
		if (offsetAt !== null) return { kind: "zone", tzid, offsetAt, wall };
	}
	return { kind: "floating", wall };
}

/** The UTC offset of an aware value, or null for a date or floating value. */
export function offsetOf(t: TimeValue): number | null {
	if (t.kind === "utc") return 0;
	if (t.kind === "zone") {
		// zoneinfo semantics (fold=0) for the instant this wall clock names.
		const w = wallMs(t.wall);
		return w - wallToEpoch(w, t.offsetAt);
	}
	return null;
}

/** Python's isoformat() of the decoded value. */
export function timeIso(t: TimeValue): string {
	return isoformat(t.wall, {
		isDate: t.kind === "date",
		offsetMs: offsetOf(t),
	});
}

/**
 * Python's `todo.decoded(name).isoformat()` for the first `name` property,
 * or null when the component has none.
 */
export function decodedIso(
	component: IcalComponent,
	name: string,
): string | null {
	const prop = component.getFirstProperty(name.toLowerCase());
	return prop === null ? null : timeIso(decodeTime(prop, component));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function jcalDate(w: WallClock): string {
	return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

function jcalDateTime(w: WallClock): string {
	return `${jcalDate(w)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** A fresh property holding `t`: VALUE=DATE, `...Z`, floating or TZID=. */
export function timeProperty(name: string, t: TimeValue): IcalProperty {
	const lower = name.toLowerCase();
	switch (t.kind) {
		case "date":
			return new ICAL.Property([lower, {}, "date", jcalDate(t.wall)]);
		case "utc":
			return new ICAL.Property([
				lower,
				{},
				"date-time",
				`${jcalDateTime(t.wall)}Z`,
			]);
		case "floating":
			return new ICAL.Property([lower, {}, "date-time", jcalDateTime(t.wall)]);
		case "zone":
			return new ICAL.Property([
				lower,
				{ tzid: t.tzid },
				"date-time",
				jcalDateTime(t.wall),
			]);
	}
}

/** An instant as a UTC DATE-TIME value (sub-second precision dropped). */
export function utcValue(instant: Date): TimeValue {
	return { kind: "utc", wall: wallFromMs(instant.getTime()) };
}
