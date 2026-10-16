import { describe, expect, test } from "bun:test";

import {
	IsoFormatError,
	parsePythonIsoDatetime,
	pyRepr,
} from "./python-compat.server";

describe("pyRepr", () => {
	test.each([
		[null, "None"],
		[true, "True"],
		[false, "False"],
		[42, "42"],
		[1.5, "1.5"],
		["ghost", "'ghost'"],
		["it's", `"it's"`],
		[`it's "x"`, `'it\\'s "x"'`],
		["a\nb\\", "'a\\nb\\\\'"],
		["lišta", "'lišta'"],
		[[1, "a"], "[1, 'a']"],
		[{ k: null }, "{'k': None}"],
	])("%p -> %s", (value, expected) => {
		expect(pyRepr(value)).toBe(expected);
	});
});

describe("parsePythonIsoDatetime matches datetime.fromisoformat", () => {
	// Captured from Python 3.13: datetime.fromisoformat(s), naive made UTC.
	test.each([
		["2026-07-02T08:30:00.123Z", "2026-07-02T08:30:00.123Z"],
		["2026-07-02T08:30:00.1234567", "2026-07-02T08:30:00.123Z"],
		["20260702T083000", "2026-07-02T08:30:00.000Z"],
		["2026-07-02 08:30", "2026-07-02T08:30:00.000Z"],
		["2026-07-02T08", "2026-07-02T08:00:00.000Z"],
		["2026-07-02", "2026-07-02T00:00:00.000Z"],
		["2026-07-02T08:30:00+0200", "2026-07-02T06:30:00.000Z"],
		["2026-07-02T08:30:00+02", "2026-07-02T06:30:00.000Z"],
		["2026-07-02T08:30:00,5", "2026-07-02T08:30:00.500Z"],
		["2026-07-02T08:30:00-00:30:15.5", "2026-07-02T09:00:15.500Z"],
		["2024-02-29T00:00:00+00:00", "2024-02-29T00:00:00.000Z"],
	])("%s", (raw, iso) => {
		expect(parsePythonIsoDatetime(raw).toISOString()).toBe(iso);
	});

	test.each([
		["yesterdayish", "Invalid isoformat string: 'yesterdayish'"],
		["2026-13-01", "month must be in 1..12"],
		["2026-02-30", "day is out of range for month"],
		["2025-02-29", "day is out of range for month"],
		["2026-07-02T24:00:00", "hour must be in 0..23"],
		["2026-07-02T25:00", "hour must be in 0..23"],
		["2026-07-02T08:30:60", "second must be in 0..59"],
		["2026-07-02T", "Invalid isoformat string: '2026-07-02T'"],
		["", "Invalid isoformat string: ''"],
	])("%s is rejected", (raw, message) => {
		expect(() => parsePythonIsoDatetime(raw)).toThrow(IsoFormatError);
		expect(() => parsePythonIsoDatetime(raw)).toThrow(message);
	});
});
