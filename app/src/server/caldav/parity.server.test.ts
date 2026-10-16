/**
 * Differential test against the Python build, which is the correctness
 * oracle for this port. It generates cases with fast-check, runs them through
 * both implementations (Python once, in one process) and compares:
 *
 * - completion roll-forward: DUE, DTSTART, COMPLETED, STATUS and COUNT after
 *   applyComplete, over random rules, bases (UTC, floating, all-day, TZID),
 *   UNTIL forms, household zones and completion instants;
 * - applyFields / buildVtodo: the full set of unfolded output lines and the
 *   parsed Task, over random titles, notes, due strings, priorities and
 *   sort orders (including invalid ones, where both must refuse);
 * - parseTask on every generated object;
 * - encodeCursor, byte for byte.
 *
 * Runs only when TASKS_PYTHON_ORACLE points at the backend's Python, e.g.
 *   TASKS_PYTHON_ORACLE=../backend/.venv/bin/python bun run test
 * TASKS_PYTHON_BACKEND overrides the backend directory (default ../backend);
 * TASKS_PARITY_DUMP=<file> appends every mismatch there as JSON.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import ICAL from "ical.js";

import { encodeCursor } from "../sync/cursor.server";
import { decodedIso } from "./ical-time.server";
import {
	applyComplete,
	applyFields,
	buildVtodo,
	type OpTaskFields,
	parseTask,
} from "./ics.server";
import { GOLDENS, loadGolden, unfoldLines } from "./testing/fixtures.server";

const pythonBin = process.env.TASKS_PYTHON_ORACLE;
const backendDir =
	process.env.TASKS_PYTHON_BACKEND ?? join(process.cwd(), "..", "backend");
const SEED = Number(process.env.TASKS_PARITY_SEED ?? 20261016);

type Case =
	| { kind: "complete"; ics: string; now: string; tz: string }
	| {
			kind: "fields";
			ics: string;
			now: string;
			fields: Record<string, unknown>;
	  }
	| { kind: "build"; uid: string; now: string; fields: Record<string, unknown> }
	| { kind: "parse"; ics: string }
	| {
			kind: "cursor";
			tokens: Record<string, string>;
			hrefs: Record<string, string>;
	  };

type Outcome = { ok: unknown } | { error: string; message?: string };

// ---------------------------------------------------------------- generators

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const ymd = (d: Date) =>
	`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const hms = (d: Date) =>
	`${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

type BaseKind =
	| "utc"
	| "floating"
	| "date"
	| "Europe/Sofia"
	| "America/New_York"
	// Windows names and a slashed IANA name, with no VTIMEZONE: icalendar
	// maps them to IANA zones.
	| "W. Europe Standard Time"
	| "Eastern Standard Time"
	| "/Europe/Sofia";

function timeLine(name: string, kind: BaseKind, wall: Date): string {
	switch (kind) {
		case "utc":
			return `${name}:${ymd(wall)}T${hms(wall)}Z`;
		case "floating":
			return `${name}:${ymd(wall)}T${hms(wall)}`;
		case "date":
			return `${name};VALUE=DATE:${ymd(wall)}`;
		default:
			return `${name};TZID=${kind}:${ymd(wall)}T${hms(wall)}`;
	}
}

const DAY = 86_400_000;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const completeCase: fc.Arbitrary<Case> = fc
	.record({
		kind: fc.constantFrom<BaseKind>(
			"utc",
			"floating",
			"date",
			"Europe/Sofia",
			"America/New_York",
			"W. Europe Standard Time",
			"Eastern Standard Time",
			"/Europe/Sofia",
		),
		base: fc.date({
			min: new Date("2025-01-01T00:00:00Z"),
			max: new Date("2027-12-28T00:00:00Z"),
			noInvalidDate: true,
		}),
		minute: fc.constantFrom(0, 15, 30, 45),
		layout: fc.constantFrom("due", "start", "both"),
		durationHours: fc.integer({ min: 0, max: 72 }),
		freq: fc.constantFrom("DAILY", "WEEKLY", "MONTHLY", "YEARLY"),
		interval: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
		byday: fc.option(fc.subarray([...WEEKDAYS], { minLength: 1 }), {
			nil: undefined,
		}),
		bymonthday: fc.option(fc.constantFrom(1, 10, 15, 28, -1), {
			nil: undefined,
		}),
		end: fc.oneof(
			fc.constant<{ type: "none" }>({ type: "none" }),
			fc.record({
				type: fc.constant<"count">("count"),
				count: fc.integer({ min: 1, max: 20 }),
			}),
			fc.record({
				type: fc.constantFrom<"until-utc" | "until-date">(
					"until-utc",
					"until-date",
				),
				days: fc.integer({ min: -10, max: 400 }),
			}),
		),
		nowMinutes: fc.integer({ min: -3 * 24 * 60, max: 420 * 24 * 60 }),
		tz: fc.constantFrom("Europe/Sofia", "UTC", "America/New_York"),
	})
	.map((g) => {
		const base = new Date(g.base);
		base.setUTCHours(base.getUTCHours(), g.minute, 0, 0);
		const parts = [`FREQ=${g.freq}`];
		if (g.interval !== undefined) parts.push(`INTERVAL=${g.interval}`);
		if (g.freq === "WEEKLY" && g.byday)
			parts.push(`BYDAY=${g.byday.join(",")}`);
		if (g.freq === "MONTHLY" && g.bymonthday !== undefined) {
			parts.push(`BYMONTHDAY=${g.bymonthday}`);
		}
		if (g.end.type === "count") parts.push(`COUNT=${g.end.count}`);
		if (g.end.type === "until-utc" || g.end.type === "until-date") {
			const until = new Date(base.getTime() + g.end.days * DAY);
			parts.push(
				g.end.type === "until-utc"
					? `UNTIL=${ymd(until)}T215959Z`
					: `UNTIL=${ymd(until)}`,
			);
		}
		const props: string[] = [];
		if (g.layout !== "due") props.push(timeLine("DTSTART", g.kind, base));
		if (g.layout !== "start") {
			const due =
				g.layout === "both"
					? new Date(
							base.getTime() +
								(g.kind === "date"
									? Math.floor(g.durationHours / 24) * DAY
									: g.durationHours * 3_600_000),
						)
					: base;
			props.push(timeLine("DUE", g.kind, due));
		}
		props.push(`RRULE:${parts.join(";")}`);
		const ics =
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//parity//EN\r\nBEGIN:VTODO\r\n" +
			"UID:p-1\r\nSUMMARY:p\r\nSTATUS:NEEDS-ACTION\r\n" +
			props.map((p) => `${p}\r\n`).join("") +
			"END:VTODO\r\nEND:VCALENDAR\r\n";
		const now = new Date(base.getTime() + g.nowMinutes * 60_000);
		return {
			kind: "complete" as const,
			ics,
			now: now.toISOString().replace("Z", "+00:00"),
			tz: g.tz,
		};
	});

/**
 * Sub-daily rules (SECONDLY/MINUTELY/HOURLY), which the port jumps through
 * instead of walking from the base. The gap to "now" is bounded per frequency
 * so dateutil, which walks every occurrence, stays fast. BYWEEKNO is left out:
 * the port reports it as unsupported on purpose (recurrence.server.test.ts).
 */
const subDailyCase: fc.Arbitrary<Case> = fc
	.record({
		kind: fc.constantFrom<BaseKind>(
			"utc",
			"floating",
			"date",
			"Europe/Sofia",
			"America/New_York",
		),
		base: fc.date({
			min: new Date("2025-01-01T00:00:00Z"),
			max: new Date("2026-12-28T00:00:00Z"),
			noInvalidDate: true,
		}),
		freq: fc.constantFrom("SECONDLY", "MINUTELY", "HOURLY"),
		interval: fc.option(fc.integer({ min: 1, max: 45 }), { nil: undefined }),
		byhour: fc.option(fc.subarray([0, 6, 9, 10, 17, 23], { minLength: 1 }), {
			nil: undefined,
		}),
		byminute: fc.option(fc.subarray([0, 15, 30, 59], { minLength: 1 }), {
			nil: undefined,
		}),
		until: fc.option(fc.integer({ min: -2, max: 30 }), { nil: undefined }),
		layout: fc.constantFrom("due", "both"),
		gapFraction: fc.double({ min: -0.01, max: 1, noNaN: true }),
		tz: fc.constantFrom("Europe/Sofia", "UTC", "America/New_York"),
	})
	.map((g) => {
		const maxGapMinutes = {
			SECONDLY: 6 * 60,
			MINUTELY: 10 * 24 * 60,
			HOURLY: 400 * 24 * 60,
		}[g.freq];
		const base = new Date(g.base);
		base.setUTCSeconds(17, 0);
		const parts = [`FREQ=${g.freq}`];
		if (g.interval !== undefined) parts.push(`INTERVAL=${g.interval}`);
		if (g.byhour && g.freq !== "HOURLY")
			parts.push(`BYHOUR=${g.byhour.join(",")}`);
		if (g.byminute && g.freq !== "MINUTELY" && g.freq !== "SECONDLY")
			parts.push(`BYMINUTE=${g.byminute.join(",")}`);
		if (g.until !== undefined) {
			const until = new Date(base.getTime() + g.until * DAY);
			parts.push(`UNTIL=${ymd(until)}T${hms(until)}Z`);
		}
		const props = [timeLine("DUE", g.kind, base)];
		if (g.layout === "both")
			props.unshift(
				timeLine("DTSTART", g.kind, new Date(base.getTime() - 3_600_000)),
			);
		props.push(`RRULE:${parts.join(";")}`);
		const ics =
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//parity//EN\r\nBEGIN:VTODO\r\n" +
			"UID:p-2\r\nSUMMARY:p\r\nSTATUS:NEEDS-ACTION\r\n" +
			props.map((p) => `${p}\r\n`).join("") +
			"END:VTODO\r\nEND:VCALENDAR\r\n";
		const now = new Date(
			base.getTime() + Math.round(g.gapFraction * maxGapMinutes) * 60_000,
		);
		return {
			kind: "complete" as const,
			ics,
			now: now.toISOString().replace("Z", "+00:00"),
			tz: g.tz,
		};
	});

/**
 * Text without backslashes. icalendar's unescaping loses them: a title
 * `a\,b` is written as `a\\\,b` and read back as `a,b`, while ical.js reads
 * back what was written. ics.server.test.ts pins the port's behaviour.
 */
const textValue = fc
	.oneof(
		fc.string({ unit: "grapheme", maxLength: 40 }),
		fc
			.array(
				fc.constantFrom(
					"a",
					"Б",
					"“",
					"”",
					",",
					";",
					":",
					"\n",
					" ",
					"é",
					"😀",
					'"',
				),
				{ maxLength: 20 },
			)
			.map((xs) => xs.join("")),
	)
	.map((text) => text.replace(/\\/g, "/"));

const dueValue = fc.oneof(
	fc.constant(null),
	fc.constantFrom(
		"2026-07-20",
		"20260720",
		"2026-07-09T18:00:00",
		"2026-07-09 18:00",
		"2026-07-09T18:00",
		"2026-07-08T10:30:00+03:00",
		"2026-07-08T10:30:00Z",
		"2026-07-08T10:30:00.123456-04:30",
		"2026-07-08T10:30:00+0530",
		"2026-02-30",
		"2026-07-08T25:00:00",
		"not-a-date",
		"",
		"2026-07-08T",
	),
	fc.integer(),
);

const fieldsValue = fc.record(
	{
		title: textValue,
		notes: textValue,
		due: dueValue,
		due_has_time: fc.oneof(fc.boolean(), fc.constant(null)),
		priority: fc.constantFrom(0, 1, 5, 9, 3, "1", true, null),
		sort_order: fc.oneof(
			fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
			fc.constantFrom(null, 1.5, "2", true),
		),
	},
	{ requiredKeys: [] },
);

const NOW_ISO = "2026-07-03T12:00:00+00:00";

const fieldsCase: fc.Arbitrary<Case> = fc
	.record({ golden: fc.constantFrom(...GOLDENS), fields: fieldsValue })
	.map(({ golden, fields }) => ({
		kind: "fields" as const,
		ics: loadGolden(golden),
		now: NOW_ISO,
		fields,
	}));

const buildCase: fc.Arbitrary<Case> = fc
	.record({ uid: fc.uuid(), fields: fieldsValue })
	.map(({ uid, fields }) => ({
		kind: "build" as const,
		uid,
		now: NOW_ISO,
		fields,
	}));

const cursorKey = fc
	.string({ unit: "binary", minLength: 1, maxLength: 12 })
	.filter((k) => !/^(0|[1-9]\d*)$/.test(k)); // see the divergence note below
const cursorCase: fc.Arbitrary<Case> = fc
	.record({
		tokens: fc.dictionary(cursorKey, fc.string({ unit: "binary" })),
		hrefs: fc.dictionary(cursorKey, fc.string({ unit: "binary" })),
	})
	.map((c) => ({ kind: "cursor" as const, ...c }));

// ---------------------------------------------------------------- TS side

function summarize(ics: string) {
	const cal = new ICAL.Component(ICAL.parse(ics));
	const todo = cal.getAllSubcomponents("vtodo")[0];
	if (todo === undefined) throw new Error("no vtodo");
	const rrule = todo.getFirstProperty("rrule");
	const count = rrule ? (rrule.jCal[3] as { count?: number }).count : undefined;
	return {
		due: decodedIso(todo, "due"),
		dtstart: decodedIso(todo, "dtstart"),
		completed: decodedIso(todo, "completed"),
		status: String(todo.getFirstPropertyValue("status") ?? ""),
		count: count ?? null,
	};
}

function runTs(c: Case): Outcome {
	const savedTz = process.env.TASKS_LOCAL_TZ;
	try {
		switch (c.kind) {
			case "complete": {
				process.env.TASKS_LOCAL_TZ = c.tz;
				return { ok: summarize(applyComplete(c.ics, new Date(c.now))) };
			}
			case "fields": {
				const out = applyFields(
					c.ics,
					c.fields as OpTaskFields,
					new Date(c.now),
				);
				return { ok: { lines: unfoldLines(out), task: parseTask(out) } };
			}
			case "build": {
				const out = buildVtodo(
					c.uid,
					c.fields as OpTaskFields,
					new Date(c.now),
				);
				return { ok: { lines: unfoldLines(out), task: parseTask(out) } };
			}
			case "parse":
				return { ok: { task: parseTask(c.ics) } };
			case "cursor":
				return { ok: { cursor: encodeCursor(c.tokens, c.hrefs) } };
			default: {
				const unknown: never = c;
				throw new Error(`unknown case ${JSON.stringify(unknown)}`);
			}
		}
	} catch (err) {
		return {
			error: err instanceof Error ? err.name : String(err),
			message: err instanceof Error ? err.message : undefined,
		};
	} finally {
		if (savedTz === undefined) delete process.env.TASKS_LOCAL_TZ;
		else process.env.TASKS_LOCAL_TZ = savedTz;
	}
}

function runPython(cases: Case[]): Outcome[] {
	const proc = Bun.spawnSync(
		[
			pythonBin ?? "",
			"-I",
			join(import.meta.dir, "testing", "python_oracle.py"),
			backendDir,
		],
		{ stdin: Buffer.from(JSON.stringify(cases)) },
	);
	if (proc.exitCode !== 0) {
		throw new Error(`python oracle failed: ${proc.stderr.toString()}`);
	}
	return JSON.parse(proc.stdout.toString()) as Outcome[];
}

/** Sort line arrays so property order (which may differ) does not count. */
function normalise(outcome: Outcome): Outcome {
	if (
		"ok" in outcome &&
		typeof outcome.ok === "object" &&
		outcome.ok !== null
	) {
		const ok = outcome.ok as Record<string, unknown>;
		if (Array.isArray(ok.lines)) {
			return { ok: { ...ok, lines: [...(ok.lines as string[])].sort() } };
		}
	}
	return outcome;
}

/**
 * Error classes compare by name. Python raises TypeError where it subtracts a
 * naive DTSTART from an aware DUE; the port raises RecurrenceError there.
 */
function sameOutcome(py: Outcome, ts: Outcome): boolean {
	if ("error" in py || "error" in ts) {
		if (!("error" in py && "error" in ts)) return false;
		return (
			py.error === ts.error ||
			(py.error === "TypeError" && ts.error === "RecurrenceError")
		);
	}
	return JSON.stringify(normalise(py)) === JSON.stringify(normalise(ts));
}

function compare(cases: Case[]): void {
	const python = runPython(cases);
	const mismatches: { case: Case; python: Outcome; ts: Outcome }[] = [];
	cases.forEach((c, i) => {
		const py = python[i] ?? { error: "missing" };
		const ts = runTs(c);
		if (!sameOutcome(py, ts)) mismatches.push({ case: c, python: py, ts });
	});
	const dump = process.env.TASKS_PARITY_DUMP;
	if (dump && mismatches.length > 0) {
		appendFileSync(dump, `${JSON.stringify(mismatches, null, 1)}\n`);
	}
	expect(
		mismatches.slice(0, 5),
		`${mismatches.length} of ${cases.length} cases differ`,
	).toEqual([]);
}

const sample = <T>(arb: fc.Arbitrary<T>, numRuns: number, offset: number) =>
	fc.sample(arb, { numRuns, seed: SEED + offset });

describe.skipIf(!pythonBin)("parity with the Python build", () => {
	test("completion roll-forward", () => {
		compare(sample(completeCase, 1500, 1));
	}, 60_000);

	test("sub-daily roll-forward from an old base", () => {
		compare(sample(subDailyCase, 80, 6));
	}, 180_000);

	test("applyFields on the goldens", () => {
		compare(sample(fieldsCase, 600, 2));
	}, 60_000);

	test("buildVtodo", () => {
		compare(sample(buildCase, 300, 3));
	}, 60_000);

	test("parseTask on goldens and generated objects", () => {
		const generated = sample(completeCase, 300, 4).map((c) => ({
			kind: "parse" as const,
			ics: c.kind === "complete" ? c.ics : "",
		}));
		const goldens = GOLDENS.map((g) => ({
			kind: "parse" as const,
			ics: loadGolden(g),
		}));
		compare([...goldens, ...generated]);
	}, 60_000);

	test("encodeCursor, byte for byte", () => {
		// Divergence: JS objects order integer-like keys first, so a cursor
		// whose list ids look like array indexes ("2024") encodes with the
		// keys in a different order. Both builds decode either form.
		compare(sample(cursorCase, 300, 5));
	}, 60_000);
});
