/**
 * Port of backend/tests/test_ics_mapper.py: golden-file round-trip fidelity
 * and field mapping for the VTODO <-> Task mapper.
 *
 * The goldens are realistic Apple/Nextcloud VTODOs (curly quotes, folded
 * lines, escaped commas, VALARM/ACKNOWLEDGED, RRULE, X-APPLE-*). The core
 * assertion: after parse-modify-serialize, every property line the transform
 * did not touch survives byte-identically (compared unfolded, since RFC 5545
 * line folding is presentation, not content).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import ICAL from "ical.js";

import {
	applyComplete,
	applyFields,
	applyUncomplete,
	buildVtodo,
	MapperError,
	normalizePriority,
	type OpTaskFields,
	parseTask,
} from "./ics.server";
import {
	GOLDENS,
	type GoldenName,
	loadGolden,
	unfoldLines,
} from "./testing/fixtures.server";

const NOW = new Date("2026-07-03T12:00:00Z");

/** Properties every rewrite is allowed to touch (bookkeeping). */
const BOOKKEEPING = new Set(["SEQUENCE", "DTSTAMP", "LAST-MODIFIED"]);

function propName(line: string): string {
	return (line.split(":", 1)[0] ?? "").split(";", 1)[0]?.toUpperCase() ?? "";
}

/** Every property line whose name is not in `touched` must survive byte for byte. */
function expectUntouchedPreserved(
	original: string,
	modified: string,
	touched: string[],
): void {
	const allowed = new Set([
		...touched.map((t) => t.toUpperCase()),
		...BOOKKEEPING,
	]);
	const newLines = unfoldLines(modified);
	for (const line of unfoldLines(original)) {
		if (allowed.has(propName(line))) continue;
		expect(newLines, `lost/altered property line: ${line}`).toContain(line);
	}
}

const has = (ics: string, line: string) => unfoldLines(ics).includes(line);
const anyStartsWith = (ics: string, prefix: string) =>
	unfoldLines(ics).some((line) => line.startsWith(prefix));

const fields = (f: Record<string, unknown>) => f as OpTaskFields;

let savedTz: string | undefined;
beforeEach(() => {
	savedTz = process.env.TASKS_LOCAL_TZ;
	delete process.env.TASKS_LOCAL_TZ;
});
afterEach(() => {
	if (savedTz === undefined) delete process.env.TASKS_LOCAL_TZ;
	else process.env.TASKS_LOCAL_TZ = savedTz;
});

describe("round trip", () => {
	test.each(GOLDENS)(
		"pure parse and serialise preserves every line: %s",
		(name: GoldenName) => {
			const original = loadGolden(name);
			const out = new ICAL.Component(ICAL.parse(original)).toString();
			expect([...unfoldLines(out.replace(/\r?\n/g, "\r\n"))].sort()).toEqual(
				[...unfoldLines(original)].sort(),
			);
		},
	);
});

describe("parseTask", () => {
	test("apple recurring alarm", () => {
		const task = parseTask(loadGolden("apple_recurring_alarm.ics"));
		expect(task).not.toBeNull();
		expect(task?.uid).toBe("6FD37E05-9AF0-4C0B-A9E9-D3B0E0F1A2B3");
		// Curly quotes intact, escaped commas unescaped, folded line joined.
		expect(task?.title).toBe(
			"Pay rent “flat 7”, water, electricity and a very long " +
				"summary line that Apple folds at seventy-five octets exactly like this",
		);
		expect(task?.notes).toBe("");
		expect(task?.due).toBe("2026-07-01T09:00:00+03:00");
		expect(task?.due_has_time).toBe(true);
		expect(task?.priority).toBe(1);
		expect(task?.completed).toBe(false);
		expect(task?.completed_at).toBeNull();
		expect(task?.recurring).toBe(true);
		// Apple-era manual order rides along (contract delta v1.3 §1).
		expect(task?.sort_order).toBe(740609486);
	});

	test("apple all-day until", () => {
		const task = parseTask(loadGolden("apple_allday_until.ics"));
		expect(task?.due).toBe("2026-06-15");
		expect(task?.due_has_time).toBe(false);
		expect(task?.priority).toBe(5);
		expect(task?.completed).toBe(true);
		expect(task?.completed_at).toBe("2026-06-15T19:15:00+00:00");
		expect(task?.recurring).toBe(true);
		expect(task?.notes).toBe("Take with food\nОт д-р Иванова, само зимата");
	});

	test("apple daily count", () => {
		const task = parseTask(loadGolden("apple_daily_count.ics"));
		expect(task?.due).toBe("2026-07-01T05:45:00+00:00");
		expect(task?.due_has_time).toBe(true);
		expect(task?.priority).toBe(9);
		expect(task?.recurring).toBe(true);
	});

	test("nextcloud simple", () => {
		const task = parseTask(loadGolden("nextcloud_simple.ics"));
		expect(task?.uid).toBe("nc-web-3f2a1b4c5d6e");
		expect(task?.due).toBeNull();
		expect(task?.due_has_time).toBe(false);
		expect(task?.priority).toBe(0);
		expect(task?.completed).toBe(false);
		expect(task?.recurring).toBe(false);
		expect(task?.sort_order).toBeNull(); // Nextcloud web writes no X-APPLE-SORT-ORDER
	});

	test("non-VTODO returns null", () => {
		const ics =
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\n" +
			"BEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260701T090000Z\r\nSUMMARY:party\r\n" +
			"END:VEVENT\r\nEND:VCALENDAR\r\n";
		expect(parseTask(ics)).toBeNull();
	});

	test("garbage raises MapperError", () => {
		expect(() => parseTask("not ics at all")).toThrow(MapperError);
	});

	// -- beyond the Python suite: wire-format details the port must keep

	test("LF line endings (calendar-data after XML parsing) parse the same", () => {
		const lf = loadGolden("apple_recurring_alarm.ics").replace(/\r\n/g, "\n");
		expect(parseTask(lf)).toEqual(
			parseTask(loadGolden("apple_recurring_alarm.ics")),
		);
	});

	test("floating and unknown-TZID datetimes stay naive", () => {
		const ics = (due: string) =>
			`BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\n${due}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
		expect(parseTask(ics("DUE:20260709T180000"))?.due).toBe(
			"2026-07-09T18:00:00",
		);
		expect(parseTask(ics("DUE;TZID=Nowhere/Land:20260709T180000"))?.due).toBe(
			"2026-07-09T18:00:00",
		);
		expect(
			parseTask(ics("DUE;TZID=America/New_York:20260109T180000"))?.due,
		).toBe("2026-01-09T18:00:00-05:00");
	});

	test("a TZID defined only by an embedded VTIMEZONE resolves through it", () => {
		const ics =
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" +
			"BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\n" +
			"BEGIN:STANDARD\r\nDTSTART:16011028T030000\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\r\n" +
			"TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\n" +
			"BEGIN:DAYLIGHT\r\nDTSTART:16010325T020000\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3\r\n" +
			"TZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n" +
			"BEGIN:VTODO\r\nUID:x\r\nDUE;TZID=W. Europe Standard Time:20260701T090000\r\n" +
			"END:VTODO\r\nEND:VCALENDAR\r\n";
		expect(parseTask(ics)?.due).toBe("2026-07-01T09:00:00+02:00");
	});

	test("a Windows TZID without a VTIMEZONE maps to its IANA zone, as icalendar did", () => {
		const due = (tzid: string) =>
			parseTask(
				"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\n" +
					`DUE;TZID=${tzid}:20260710T090000\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`,
			)?.due;
		// Values pinned from the Python build (icalendar 6.3.2).
		expect(due("W. Europe Standard Time")).toBe("2026-07-10T09:00:00+02:00");
		expect(due("Eastern Standard Time")).toBe("2026-07-10T09:00:00-04:00");
		// icalendar strips a leading "/" from a TZID.
		expect(due("/Europe/Sofia")).toBe("2026-07-10T09:00:00+03:00");
	});

	test("RRULE values ical.js rejects: lowercase is read as icalendar read it; a broken rule still shows as recurring", () => {
		const withRule = (rule: string) =>
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nSUMMARY:s\r\n" +
			`DUE:20260710T090000Z\r\nRRULE:${rule}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
		// Pinned from the Python build: both parse as recurring tasks.
		for (const rule of ["freq=daily", "FREQ=DAILY;BYDAY=MO,0WE"]) {
			const task = parseTask(withRule(rule));
			expect(task?.recurring).toBe(true);
			expect(task?.due).toBe("2026-07-10T09:00:00+00:00");
			expect(task?.title).toBe("s");
		}
		// Python wrote the lowercase rule back upper-cased and rolled it forward.
		const done = applyComplete(
			withRule("freq=daily"),
			new Date("2026-07-11T00:00:00Z"),
		);
		expect(unfoldLines(done)).toContain("RRULE:FREQ=DAILY");
		expect(unfoldLines(done)).toContain("DUE:20260711T090000Z");
		// A rule that still does not parse is never dropped by a write.
		expect(() =>
			applyComplete(
				withRule("FREQ=DAILY;BYDAY=MO,0WE"),
				new Date("2026-07-11T00:00:00Z"),
			),
		).toThrow(MapperError);
	});

	test("priority normalisation follows the Apple mapping", () => {
		expect(
			[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1].map(normalizePriority),
		).toEqual([0, 1, 1, 1, 1, 5, 9, 9, 9, 9, 0, 0]);
	});

	test("garbage PRIORITY reads as no priority (divergence: Python skipped the object)", () => {
		// icalendar raised on `PRIORITY:abc` and sync skipped the task; ical.js
		// decodes it as 0 before the mapper sees it, so the task now shows up
		// with no priority. Pinned so the difference stays deliberate.
		const ics =
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nPRIORITY:abc\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		expect(parseTask(ics)?.priority).toBe(0);
	});

	test("an unparseable DUE is a MapperError", () => {
		const ics =
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nDUE:garbage\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		expect(() => parseTask(ics)).toThrow(MapperError);
	});

	test("the master VTODO is the one without RECURRENCE-ID", () => {
		const ics =
			"BEGIN:VCALENDAR\r\n" +
			"BEGIN:VTODO\r\nUID:x\r\nRECURRENCE-ID:20260701T090000Z\r\nSUMMARY:override\r\nEND:VTODO\r\n" +
			"BEGIN:VTODO\r\nUID:x\r\nSUMMARY:master\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		expect(parseTask(ics)?.title).toBe("master");
	});
});

describe("applyFields", () => {
	test.each(GOLDENS)(
		"title edit preserves all other properties: %s",
		(name: GoldenName) => {
			const original = loadGolden(name);
			const modified = applyFields(
				original,
				fields({ title: "New title" }),
				NOW,
			);
			expectUntouchedPreserved(original, modified, ["SUMMARY"]);
			expect(has(modified, "SUMMARY:New title")).toBe(true);
		},
	);

	test("title edit bumps SEQUENCE and stamps", () => {
		const original = loadGolden("apple_recurring_alarm.ics"); // SEQUENCE:3
		const modified = applyFields(original, fields({ title: "x" }), NOW);
		expect(has(modified, "SEQUENCE:4")).toBe(true);
		expect(has(modified, "DTSTAMP:20260703T120000Z")).toBe(true);
		expect(has(modified, "LAST-MODIFIED:20260703T120000Z")).toBe(true);
	});

	test("title with specials is escaped and round trips", () => {
		const original = loadGolden("nextcloud_simple.ics");
		const modified = applyFields(
			original,
			fields({ title: "Buy milk, eggs; call “Анка”" }),
			NOW,
		);
		expect(has(modified, "SUMMARY:Buy milk\\, eggs\\; call “Анка”")).toBe(true);
		expect(parseTask(modified)?.title).toBe("Buy milk, eggs; call “Анка”");
	});

	test("backslashes round trip exactly (divergence: icalendar dropped them)", () => {
		// icalendar read `a\\\,b` back as `a,b`; ical.js returns what was written.
		for (const title of ["a\\,b", ";\\\\", "C:\\path\\n"]) {
			const modified = applyFields(
				loadGolden("nextcloud_simple.ics"),
				fields({ title, notes: title }),
				NOW,
			);
			const parsed = parseTask(modified);
			expect(parsed?.title).toBe(title);
			expect(parsed?.notes).toBe(title);
		}
	});

	test("due edit moves DTSTART with it and preserves RRULE", () => {
		const original = loadGolden("apple_recurring_alarm.ics");
		const modified = applyFields(
			original,
			fields({ due: "2026-07-08T10:30:00+03:00", due_has_time: true }),
			NOW,
		);
		// Aware datetimes are written as UTC (07:30Z == 10:30+03:00).
		expect(has(modified, "DUE:20260708T073000Z")).toBe(true);
		expect(has(modified, "DTSTART:20260708T073000Z")).toBe(true);
		expectUntouchedPreserved(original, modified, ["DUE", "DTSTART"]);
		expect(has(modified, "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE")).toBe(
			true,
		);
	});

	test("all-day due edit", () => {
		const original = loadGolden("apple_allday_until.ics");
		const modified = applyFields(original, fields({ due: "2026-07-20" }), NOW);
		expect(has(modified, "DUE;VALUE=DATE:20260720")).toBe(true);
		expect(has(modified, "DTSTART;VALUE=DATE:20260720")).toBe(true);
		expectUntouchedPreserved(original, modified, ["DUE", "DTSTART"]);
	});

	test("due clear removes DUE, keeps the rest", () => {
		const original = loadGolden("apple_daily_count.ics");
		const modified = applyFields(original, fields({ due: null }), NOW);
		expect(anyStartsWith(modified, "DUE")).toBe(false);
		expectUntouchedPreserved(original, modified, ["DUE"]);
	});

	test("naive due stays floating", () => {
		const modified = applyFields(
			loadGolden("nextcloud_simple.ics"),
			fields({ due: "2026-07-09T18:00:00", due_has_time: true }),
			NOW,
		);
		expect(has(modified, "DUE:20260709T180000")).toBe(true);
	});

	// -- inconsistent due fields (SYNC-12 / contract L)

	test("due_has_time without due is rejected, not silently cleared", () => {
		const original = loadGolden("apple_daily_count.ics"); // has DUE:20260701T054500Z
		expect(() =>
			applyFields(original, fields({ due_has_time: true }), NOW),
		).toThrow(MapperError);
	});

	test("a lone due_has_time flag does not touch DUE", () => {
		const original = loadGolden("apple_daily_count.ics");
		expect(() =>
			applyFields(original, fields({ due_has_time: false }), NOW),
		).toThrow(MapperError);
	});

	test("a datetime due without the flag is normalised to timed", () => {
		const modified = applyFields(
			loadGolden("nextcloud_simple.ics"),
			fields({ due: "2026-07-09T18:00:00" }),
			NOW,
		);
		expect(has(modified, "DUE:20260709T180000")).toBe(true);
		const parsed = parseTask(modified);
		expect(parsed?.due).toBe("2026-07-09T18:00:00");
		expect(parsed?.due_has_time).toBe(true);
	});

	test("a date due without the flag stays all-day", () => {
		const modified = applyFields(
			loadGolden("nextcloud_simple.ics"),
			fields({ due: "2026-07-20" }),
			NOW,
		);
		expect(has(modified, "DUE;VALUE=DATE:20260720")).toBe(true);
	});

	test("clearing due while due_has_time is true is rejected", () => {
		expect(() =>
			applyFields(
				loadGolden("apple_daily_count.ics"),
				fields({ due: null, due_has_time: true }),
				NOW,
			),
		).toThrow(MapperError);
	});

	test("notes set and clear", () => {
		const original = loadGolden("nextcloud_simple.ics");
		const withNotes = applyFields(
			original,
			fields({ notes: "line1\nline2, ok" }),
			NOW,
		);
		expect(has(withNotes, "DESCRIPTION:line1\\nline2\\, ok")).toBe(true);
		const cleared = applyFields(withNotes, fields({ notes: "" }), NOW);
		expect(anyStartsWith(cleared, "DESCRIPTION")).toBe(false);
	});

	test("priority set and clear", () => {
		const original = loadGolden("nextcloud_simple.ics");
		const high = applyFields(original, fields({ priority: 1 }), NOW);
		expect(has(high, "PRIORITY:1")).toBe(true);
		const cleared = applyFields(high, fields({ priority: 0 }), NOW);
		expect(anyStartsWith(cleared, "PRIORITY")).toBe(false);
	});

	test.each([[{ priority: 3 }], [{ priority: "1" }], [{ priority: true }]])(
		"invalid priority rejected: %p",
		(bad) => {
			expect(() =>
				applyFields(loadGolden("nextcloud_simple.ics"), fields(bad), NOW),
			).toThrow(MapperError);
		},
	);

	// -- sort_order <-> X-APPLE-SORT-ORDER (contract delta v1.3)

	test("sort_order update rewrites the Apple-era value", () => {
		// The golden carries Apple's own X-APPLE-SORT-ORDER:740609486: an
		// update replaces exactly that line and everything else survives.
		const original = loadGolden("apple_recurring_alarm.ics");
		const modified = applyFields(original, fields({ sort_order: 123 }), NOW);
		const lines = unfoldLines(modified);
		expect(lines.filter((l) => l === "X-APPLE-SORT-ORDER:123")).toHaveLength(1);
		expect(
			lines.some(
				(l) =>
					l.startsWith("X-APPLE-SORT-ORDER") && l !== "X-APPLE-SORT-ORDER:123",
			),
		).toBe(false);
		expectUntouchedPreserved(original, modified, ["X-APPLE-SORT-ORDER"]);
		expect(parseTask(modified)?.sort_order).toBe(123);
	});

	test("sort_order set on an object without one", () => {
		const original = loadGolden("nextcloud_simple.ics");
		const modified = applyFields(original, fields({ sort_order: 2048 }), NOW);
		expect(has(modified, "X-APPLE-SORT-ORDER:2048")).toBe(true);
		expectUntouchedPreserved(original, modified, ["X-APPLE-SORT-ORDER"]);
		expect(parseTask(modified)?.sort_order).toBe(2048);
	});

	test("negative sort_order round trips", () => {
		// Apple's value space is any signed integer: keep the full range.
		const modified = applyFields(
			loadGolden("nextcloud_simple.ics"),
			fields({ sort_order: -917 }),
			NOW,
		);
		expect(has(modified, "X-APPLE-SORT-ORDER:-917")).toBe(true);
		expect(parseTask(modified)?.sort_order).toBe(-917);
	});

	test("sort_order clear removes the property", () => {
		const original = loadGolden("apple_recurring_alarm.ics");
		const cleared = applyFields(original, fields({ sort_order: null }), NOW);
		expect(anyStartsWith(cleared, "X-APPLE-SORT-ORDER")).toBe(false);
		expectUntouchedPreserved(original, cleared, ["X-APPLE-SORT-ORDER"]);
	});

	test("an unrelated edit preserves sort_order byte-identically", () => {
		const modified = applyFields(
			loadGolden("apple_recurring_alarm.ics"),
			fields({ title: "renamed" }),
			NOW,
		);
		expect(has(modified, "X-APPLE-SORT-ORDER:740609486")).toBe(true);
	});

	test("a garbage sort_order value reads as null", () => {
		const ics =
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\n" +
			"BEGIN:VTODO\r\nUID:g-1\r\nSUMMARY:odd\r\n" +
			"X-APPLE-SORT-ORDER:not-a-number\r\n" +
			"END:VTODO\r\nEND:VCALENDAR\r\n";
		expect(parseTask(ics)?.sort_order).toBeNull();
	});

	test.each([
		[{ sort_order: true }],
		[{ sort_order: "1024" }],
		[{ sort_order: 1.5 }],
	])("invalid sort_order rejected: %p", (bad) => {
		expect(() =>
			applyFields(loadGolden("nextcloud_simple.ics"), fields(bad), NOW),
		).toThrow(MapperError);
	});

	test("invalid due rejected", () => {
		expect(() =>
			applyFields(
				loadGolden("nextcloud_simple.ics"),
				fields({ due: "not-a-date", due_has_time: true }),
				NOW,
			),
		).toThrow(MapperError);
	});

	test("non-string due rejected", () => {
		expect(() =>
			applyFields(
				loadGolden("nextcloud_simple.ics"),
				fields({ due: 20260720 }),
				NOW,
			),
		).toThrow(MapperError);
	});

	test("unknown field rejected", () => {
		expect(() =>
			applyFields(
				loadGolden("nextcloud_simple.ics"),
				fields({ color: "red" }),
				NOW,
			),
		).toThrow(MapperError);
	});

	test("an object without a VTODO is a MapperError", () => {
		const ics =
			"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
		expect(() => applyFields(ics, fields({ title: "x" }), NOW)).toThrow(
			MapperError,
		);
	});
});

describe("applyComplete / applyUncomplete", () => {
	test("complete non-recurring", () => {
		const original = loadGolden("nextcloud_simple.ics");
		const done = applyComplete(original, NOW);
		expect(has(done, "STATUS:COMPLETED")).toBe(true);
		expect(has(done, "COMPLETED:20260703T120000Z")).toBe(true);
		expect(has(done, "PERCENT-COMPLETE:100")).toBe(true);
		expectUntouchedPreserved(original, done, [
			"STATUS",
			"COMPLETED",
			"PERCENT-COMPLETE",
		]);
		const parsed = parseTask(done);
		expect(parsed?.completed).toBe(true);
		expect(parsed?.completed_at).toBe("2026-07-03T12:00:00+00:00");
	});

	test("complete honours the client's completed_at", () => {
		const done = applyComplete(
			loadGolden("nextcloud_simple.ics"),
			NOW,
			new Date("2026-07-02T08:30:00Z"),
		);
		expect(has(done, "COMPLETED:20260702T083000Z")).toBe(true);
	});

	test("recurring completion rolls from completed_at, not replay-time now", () => {
		// A long-overdue recurring completion replayed a week later must roll
		// to the occurrence after the COMPLETION instant, not after now (C).
		const ics =
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\n" +
			"BEGIN:VTODO\r\nUID:c-1\r\nSUMMARY:daily\r\n" +
			"DUE:20260601T054500Z\r\nRRULE:FREQ=DAILY\r\nSTATUS:NEEDS-ACTION\r\n" +
			"END:VTODO\r\nEND:VCALENDAR\r\n";
		const completedAt = new Date("2026-07-03T08:00:00Z");
		const replayNow = new Date("2026-07-10T00:00:00Z"); // a week after completion
		const rolled = applyComplete(ics, replayNow, completedAt);
		expect(has(rolled, "DUE:20260704T054500Z")).toBe(true); // not after 07-10
		expect(has(rolled, "STATUS:NEEDS-ACTION")).toBe(true);
	});

	test("recurring completion rolls forward and preserves the alarm", () => {
		const original = loadGolden("apple_daily_count.ics"); // DUE 07-01T05:45Z, COUNT=10
		const rolled = applyComplete(original, NOW); // NOW = 07-03 12:00Z
		// Next occurrence strictly after now: 07-04T05:45Z; 3 consumed.
		expect(has(rolled, "DUE:20260704T054500Z")).toBe(true);
		expect(has(rolled, "RRULE:FREQ=DAILY;COUNT=7")).toBe(true);
		expect(has(rolled, "STATUS:NEEDS-ACTION")).toBe(true);
		expect(anyStartsWith(rolled, "COMPLETED:")).toBe(false);
		// The VALARM block and X-props are untouched.
		expectUntouchedPreserved(original, rolled, ["DUE", "RRULE"]);
		const parsed = parseTask(rolled);
		expect(parsed?.completed).toBe(false);
		expect(parsed?.recurring).toBe(true);
	});

	test("an exhausted recurring task completes normally", () => {
		const original = loadGolden("apple_daily_count.ics"); // 10 daily from 07-01
		const done = applyComplete(original, new Date("2026-08-01T00:00:00Z"));
		expect(has(done, "STATUS:COMPLETED")).toBe(true);
		expect(has(done, "PERCENT-COMPLETE:100")).toBe(true);
		expect(has(done, "DUE:20260701T054500Z")).toBe(true); // unchanged
		expect(has(done, "RRULE:FREQ=DAILY;COUNT=10")).toBe(true); // verbatim
	});

	test("all-day completion rolls on the TASKS_LOCAL_TZ day", () => {
		const ics =
			"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:d\r\nDUE;VALUE=DATE:20260715\r\n" +
			"RRULE:FREQ=DAILY\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
		const at = new Date("2026-07-15T23:30:00Z"); // already 07-16 in Sofia
		expect(has(applyComplete(ics, at), "DUE;VALUE=DATE:20260717")).toBe(true);
		process.env.TASKS_LOCAL_TZ = "UTC";
		expect(has(applyComplete(ics, at), "DUE;VALUE=DATE:20260716")).toBe(true);
	});

	test("uncomplete", () => {
		const original = loadGolden("apple_allday_until.ics");
		const reopened = applyUncomplete(original, NOW);
		expect(has(reopened, "STATUS:NEEDS-ACTION")).toBe(true);
		expect(anyStartsWith(reopened, "COMPLETED:")).toBe(false);
		expect(anyStartsWith(reopened, "PERCENT-COMPLETE")).toBe(false);
		expectUntouchedPreserved(original, reopened, [
			"STATUS",
			"COMPLETED",
			"PERCENT-COMPLETE",
		]);
	});
});

describe("buildVtodo", () => {
	test("round trips", () => {
		const ics = buildVtodo(
			"new-uid-1",
			fields({
				title: "Fresh task",
				notes: "some notes",
				due: "2026-07-10T09:00:00+03:00",
				due_has_time: true,
				priority: 5,
			}),
			NOW,
		);
		expect(has(ics, "BEGIN:VCALENDAR")).toBe(true);
		expect(has(ics, "VERSION:2.0")).toBe(true);
		const parsed = parseTask(ics);
		expect(parsed?.uid).toBe("new-uid-1");
		expect(parsed?.title).toBe("Fresh task");
		expect(parsed?.notes).toBe("some notes");
		expect(parsed?.due).toBe("2026-07-10T06:00:00+00:00"); // normalised to UTC
		expect(parsed?.due_has_time).toBe(true);
		expect(parsed?.priority).toBe(5);
		expect(parsed?.completed).toBe(false);
	});

	test("all-day", () => {
		const ics = buildVtodo(
			"new-uid-2",
			fields({ title: "All day", due: "2026-07-11", due_has_time: false }),
			NOW,
		);
		expect(has(ics, "DUE;VALUE=DATE:20260711")).toBe(true);
		const parsed = parseTask(ics);
		expect(parsed?.due).toBe("2026-07-11");
		expect(parsed?.due_has_time).toBe(false);
	});

	test("with sort_order", () => {
		const ics = buildVtodo(
			"new-uid-3",
			fields({ title: "Ordered", sort_order: 3072 }),
			NOW,
		);
		expect(has(ics, "X-APPLE-SORT-ORDER:3072")).toBe(true);
		expect(parseTask(ics)?.sort_order).toBe(3072);
	});

	test.each([[{ title: "t" }], [{ title: "t", sort_order: null }]])(
		"without sort_order writes no property: %p",
		(f) => {
			const ics = buildVtodo("new-uid-4", fields(f), NOW);
			expect(anyStartsWith(ics, "X-APPLE-SORT-ORDER")).toBe(false);
			expect(parseTask(ics)?.sort_order).toBeNull();
		},
	);

	test("the template carries the Python build's bookkeeping", () => {
		const ics = buildVtodo("new-uid-5", fields({ title: "t" }), NOW);
		const lines = unfoldLines(ics);
		for (const line of [
			"PRODID:-//viktorbarzin//tasks//EN",
			"UID:new-uid-5",
			"CREATED:20260703T120000Z",
			"DTSTAMP:20260703T120000Z",
			"LAST-MODIFIED:20260703T120000Z",
			"STATUS:NEEDS-ACTION",
			"SEQUENCE:0",
			"SUMMARY:t",
		]) {
			expect(lines).toContain(line);
		}
		expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
	});
});
