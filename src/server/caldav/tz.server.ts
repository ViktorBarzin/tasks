/**
 * Wall-clock and time-zone arithmetic for the ICS mapper and recurrence.
 *
 * ical.js has no time-zone database of its own; the Python build used
 * zoneinfo. IANA zones come from Intl (the runtime's tzdata), which agrees
 * with zoneinfo for every zone and date this app meets.
 *
 * A wall clock is kept as "UTC milliseconds of the same fields"
 * (`wallMs`): it compares and adds like Python's naive datetime.
 */

export interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

/** Offset of a zone at an instant, in milliseconds east of UTC. */
export type OffsetAt = (epochMs: number) => number;

/** The wall-clock fields as UTC milliseconds (a naive datetime's ordering). */
export function wallMs(w: WallClock): number {
	const ms = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	// Date.UTC maps years 0-99 to 1900-1999; ICS years are four digits, but
	// stay exact anyway.
	if (w.year >= 0 && w.year < 100) {
		const d = new Date(ms);
		d.setUTCFullYear(w.year);
		return d.getTime();
	}
	return ms;
}

/** Inverse of wallMs (sub-second precision is dropped). */
export function wallFromMs(ms: number): WallClock {
	const d = new Date(ms);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
	};
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
	if (!formatters.has(tz)) {
		let f: Intl.DateTimeFormat | null;
		try {
			f = new Intl.DateTimeFormat("en-US", {
				timeZone: tz,
				hourCycle: "h23",
				era: "short",
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "numeric",
				minute: "numeric",
				second: "numeric",
			});
		} catch {
			f = null;
		}
		formatters.set(tz, f);
	}
	return formatters.get(tz) ?? null;
}

/** Whether the runtime knows this IANA zone name. */
export function isKnownZone(tz: string): boolean {
	return formatter(tz) !== null;
}

/** The wall clock in `tz` at an instant. Throws on an unknown zone. */
export function wallClockAt(epochMs: number, tz: string): WallClock {
	const f = formatter(tz);
	if (f === null) throw new RangeError(`unknown time zone: ${tz}`);
	const parts: Record<string, string> = {};
	for (const p of f.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
	const year = Number(parts.year);
	return {
		year: parts.era === "BC" ? 1 - year : year,
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		second: Number(parts.second),
	};
}

/** An OffsetAt for an IANA zone, or null when the runtime does not know it. */
export function ianaOffsetAt(tz: string): OffsetAt | null {
	if (!isKnownZone(tz)) return null;
	return (epochMs: number) => {
		const whole = Math.floor(epochMs / 1000) * 1000;
		return wallMs(wallClockAt(whole, tz)) - whole;
	};
}

/**
 * The instant a wall clock names in a zone, with zoneinfo's `fold=0`: an
 * ambiguous time (autumn) is its first occurrence, and a time inside a gap
 * (spring) uses the offset from before the transition.
 */
export function wallToEpoch(wall: number, offsetAt: OffsetAt): number {
	const DAY = 86_400_000;
	const before = offsetAt(wall - DAY);
	const after = offsetAt(wall + DAY);
	if (before === after) return wall - before;
	if (offsetAt(wall - before) === before) return wall - before;
	if (offsetAt(wall - after) === after) return wall - after;
	return wall - before;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * Python's isoformat: `2026-07-03` for a date, `2026-07-03T09:00:00` for a
 * naive datetime and `2026-07-03T09:00:00+03:00` for an aware one (UTC is
 * `+00:00`, never `Z`).
 */
export function isoformat(
	w: WallClock,
	options: { isDate?: boolean; offsetMs?: number | null } = {},
): string {
	const date = `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
	if (options.isDate) return date;
	const time = `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
	const offsetMs = options.offsetMs;
	if (offsetMs === undefined || offsetMs === null) return `${date}T${time}`;
	const sign = offsetMs < 0 ? "-" : "+";
	const total = Math.abs(Math.round(offsetMs / 1000));
	const hh = Math.floor(total / 3600);
	const mm = Math.floor((total % 3600) / 60);
	const ss = total % 60;
	return `${date}T${time}${sign}${pad(hh)}:${pad(mm)}${ss ? `:${pad(ss)}` : ""}`;
}
