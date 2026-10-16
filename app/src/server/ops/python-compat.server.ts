/**
 * Small pieces of Python behaviour that POST /api/ops answers depend on:
 * per-op error strings built with `{value!r}`, and `datetime.fromisoformat`
 * for `completed_at`. Clients show and dead-letter those strings, so they
 * keep the Python build's wording.
 */

/** Python's `repr()` for JSON values: 'str', None, True, 42, [1, 'a'], {'k': 1}. */
export function pyRepr(value: unknown): string {
	if (value === null || value === undefined) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "nan";
		if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
		return String(value);
	}
	if (typeof value === "string") return reprString(value);
	if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
	if (typeof value === "object") {
		const items = Object.entries(value).map(
			([k, v]) => `${reprString(k)}: ${pyRepr(v)}`,
		);
		return `{${items.join(", ")}}`;
	}
	return String(value);
}

function reprString(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\\") out += "\\\\";
		else if (ch === quote) out += `\\${quote}`;
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
			out += `\\x${code.toString(16).padStart(2, "0")}`;
		} else out += ch;
	}
	return `${quote}${out}${quote}`;
}

/** A value `datetime.fromisoformat` rejects; the message is Python's. */
export class IsoFormatError extends Error {}

const DATE_RE = /^(\d{4})-?(\d{2})-?(\d{2})$/;
const TIME_RE = /^(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?$/;
const OFFSET_RE =
	/^(?:Z|([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)$/;

function daysInMonth(year: number, month: number): number {
	const last = new Date(0);
	last.setUTCFullYear(year, month, 0);
	return last.getUTCDate();
}

/**
 * `datetime.fromisoformat(raw)` (Python 3.11+) for calendar dates, made
 * aware: a naive value is UTC, as ops.py did with `replace(tzinfo=UTC)`.
 * Week and ordinal dates are rejected (Python accepts them; no client sends
 * them). Sub-millisecond digits are dropped, since Date holds milliseconds.
 */
export function parsePythonIsoDatetime(raw: string): Date {
	const invalid = () =>
		new IsoFormatError(`Invalid isoformat string: ${pyRepr(raw)}`);
	const datePart =
		raw.length >= 10 && raw[4] === "-" ? raw.slice(0, 10) : raw.slice(0, 8);
	const date = DATE_RE.exec(datePart);
	if (!date) throw invalid();
	const rest = raw.slice(datePart.length);
	let timeText = "";
	let offsetText = "";
	if (rest.length > 0) {
		// Any single character separates date and time.
		const afterSep = [...rest].slice(1).join("");
		const offsetAt = afterSep.search(/[Z+-]/);
		timeText = offsetAt < 0 ? afterSep : afterSep.slice(0, offsetAt);
		offsetText = offsetAt < 0 ? "" : afterSep.slice(offsetAt);
		if (timeText === "") throw invalid();
	}
	const time = TIME_RE.exec(timeText);
	if (timeText !== "" && !time) throw invalid();
	const offset = offsetText === "" ? null : OFFSET_RE.exec(offsetText);
	if (offsetText !== "" && !offset) throw invalid();

	const year = Number(date[1]);
	const month = Number(date[2]);
	const day = Number(date[3]);
	const hour = Number(time?.[1] ?? 0);
	const minute = Number(time?.[2] ?? 0);
	const second = Number(time?.[3] ?? 0);
	const millis = Number((time?.[4] ?? "").padEnd(3, "0").slice(0, 3));
	if (year < 1) throw new IsoFormatError(`year ${year} is out of range`);
	if (month < 1 || month > 12)
		throw new IsoFormatError("month must be in 1..12");
	if (day < 1 || day > daysInMonth(year, month)) {
		throw new IsoFormatError("day is out of range for month");
	}
	if (hour > 23) throw new IsoFormatError("hour must be in 0..23");
	if (minute > 59) throw new IsoFormatError("minute must be in 0..59");
	if (second > 59) throw new IsoFormatError("second must be in 0..59");

	let offsetMs = 0;
	if (offset?.[1]) {
		const sign = offset[1] === "-" ? -1 : 1;
		offsetMs =
			sign *
			((Number(offset[2]) * 3600 +
				Number(offset[3] ?? 0) * 60 +
				Number(offset[4] ?? 0)) *
				1000 +
				Number((offset[5] ?? "").padEnd(3, "0").slice(0, 3)));
		if (Math.abs(offsetMs) >= 86_400_000) {
			throw new IsoFormatError(
				"offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24)",
			);
		}
	}
	const result = new Date(0);
	result.setUTCFullYear(year, month - 1, day);
	result.setUTCHours(hour, minute, second, millis);
	return new Date(result.getTime() - offsetMs);
}
