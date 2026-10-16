/**
 * Port of backend/tests/test_recurrence.py: completion roll-forward.
 *
 * DUE/DTSTART advance to the next occurrence strictly after now; COUNT/UNTIL
 * exhaustion means normal completion. Covers daily/weekly/monthly, all-day vs
 * timed, time zones (including a DST crossing and Apple's UTC UNTIL on an
 * all-day task), and a property pinning COUNT bookkeeping to an oracle. The
 * Python oracle was dateutil; here it is a closed-form calculation for the
 * FREQ/INTERVAL/COUNT rules the property generates.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import ICAL from "ical.js";

import { decodedIso } from "./ical-time.server";
import {
	type IcalComponent,
	type IcalRecur,
	type IcalTime,
	nextOccurrence,
	RecurrenceError,
	rollForward,
} from "./recurrence.server";

const SOFIA = "Europe/Sofia";

function parseVtodo(...props: string[]): IcalComponent {
	const ics =
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n" +
		"BEGIN:VTODO\r\nUID:t-1\r\nSUMMARY:t\r\n" +
		props.map((p) => `${p}\r\n`).join("") +
		"END:VTODO\r\nEND:VCALENDAR\r\n";
	const cal = new ICAL.Component(ICAL.parse(ics));
	const todo = cal.getFirstSubcomponent("vtodo");
	if (todo === null) throw new Error("no vtodo");
	return todo;
}

/** The DUE/DTSTART value as Python's isoformat() of todo.decoded(name). */
const decoded = (todo: IcalComponent, name: string) => decodedIso(todo, name);

/** The RRULE line's value as serialised. */
function ruleText(todo: IcalComponent): string {
	const line = todo
		.toString()
		.replace(/\r\n[ \t]/g, "")
		.split("\r\n")
		.find((l) => l.startsWith("RRULE"));
	return line?.slice("RRULE:".length) ?? "";
}

const roll = (todo: IcalComponent, now: string, tz = SOFIA) =>
	rollForward(todo, new Date(now), tz);

describe("daily / weekly / monthly", () => {
	test("daily timed rolls to the next occurrence after now", () => {
		const todo = parseVtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-03T12:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-04T05:45:00+00:00");
		expect(ruleText(todo)).toBe("FREQ=DAILY");
	});

	test("weekly with interval and BYDAY", () => {
		// Anchored Wed 2026-07-01; every 2 weeks on Mo/We.
		const todo = parseVtodo(
			"DUE:20260701T090000Z",
			"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
		);
		expect(roll(todo, "2026-07-01T09:30:00Z")).toBe(true); // just after the anchor
		// Next in the 2-weekly MO/WE sequence: Mon 2026-07-13.
		expect(decoded(todo, "DUE")).toBe("2026-07-13T09:00:00+00:00");
		expect(ruleText(todo)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
	});

	test("monthly all-day stays a DATE", () => {
		const todo = parseVtodo(
			"DTSTART;VALUE=DATE:20260615",
			"DUE;VALUE=DATE:20260615",
			"RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
		);
		expect(roll(todo, "2026-07-03T12:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-15");
		expect(decoded(todo, "DTSTART")).toBe("2026-07-15");
		expect(todo.toString()).toContain("DUE;VALUE=DATE:20260715");
	});

	test("overdue skips every missed occurrence", () => {
		const todo = parseVtodo("DUE:20260101T080000Z", "RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-03T07:59:00Z")).toBe(true); // half a year overdue
		expect(decoded(todo, "DUE")).toBe("2026-07-03T08:00:00+00:00");
	});

	test("early completion still advances past the current DUE", () => {
		const todo = parseVtodo("DUE:20260710T080000Z", "RRULE:FREQ=WEEKLY");
		expect(roll(todo, "2026-07-03T12:00:00Z")).toBe(true); // a week early
		expect(decoded(todo, "DUE")).toBe("2026-07-17T08:00:00+00:00");
	});
});

describe("COUNT bookkeeping", () => {
	test("COUNT decrements by the consumed occurrences", () => {
		const todo = parseVtodo(
			"DUE:20260701T054500Z",
			"RRULE:FREQ=DAILY;COUNT=10",
		);
		expect(roll(todo, "2026-07-03T12:00:00Z")).toBe(true); // 07-01..07-03 consumed
		expect(decoded(todo, "DUE")).toBe("2026-07-04T05:45:00+00:00");
		expect(ruleText(todo)).toBe("FREQ=DAILY;COUNT=7");
	});

	test("an on-time completion consumes exactly one", () => {
		const todo = parseVtodo(
			"DUE:20260701T054500Z",
			"RRULE:FREQ=DAILY;COUNT=10",
		);
		expect(roll(todo, "2026-07-01T06:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-02T05:45:00+00:00");
		expect(ruleText(todo)).toBe("FREQ=DAILY;COUNT=9");
	});

	test("an exhausted COUNT means normal completion", () => {
		const todo = parseVtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=3");
		expect(roll(todo, "2026-08-01T00:00:00Z")).toBe(false); // past all 3
		expect(decoded(todo, "DUE")).toBe("2026-07-01T05:45:00+00:00"); // untouched
		expect(ruleText(todo)).toBe("FREQ=DAILY;COUNT=3"); // verbatim
	});

	test("the last remaining occurrence rolls to it", () => {
		const todo = parseVtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=3");
		expect(roll(todo, "2026-07-02T12:00:00Z")).toBe(true); // only 07-03 remains
		expect(decoded(todo, "DUE")).toBe("2026-07-03T05:45:00+00:00");
		expect(ruleText(todo)).toBe("FREQ=DAILY;COUNT=1");
	});

	test("only COUNT changes; the other parts keep their order", () => {
		const todo = parseVtodo(
			"DUE:20260701T090000Z",
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6;INTERVAL=2",
		);
		expect(roll(todo, "2026-07-01T09:30:00Z")).toBe(true);
		expect(ruleText(todo)).toBe("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5;INTERVAL=2");
	});
});

describe("UNTIL", () => {
	test("an exhausted UNTIL means normal completion", () => {
		const todo = parseVtodo(
			"DUE;VALUE=DATE:20260615",
			"RRULE:FREQ=MONTHLY;UNTIL=20261231T215959Z;BYMONTHDAY=15",
		);
		expect(roll(todo, "2027-01-10T00:00:00Z")).toBe(false);
	});

	test("Apple's UTC UNTIL on an all-day task", () => {
		// Apple writes UNTIL as a UTC date-time even when DUE is a bare DATE.
		const todo = parseVtodo(
			"DTSTART;VALUE=DATE:20260615",
			"DUE;VALUE=DATE:20260615",
			"RRULE:FREQ=MONTHLY;UNTIL=20261231T215959Z;BYMONTHDAY=15",
		);
		expect(roll(todo, "2026-11-20T12:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-12-15");
		// UNTIL preserved verbatim, still in UTC date-time form.
		expect(ruleText(todo)).toContain("UNTIL=20261231T215959Z");
	});

	test("UNTIL on a timed, aware task", () => {
		const todo = parseVtodo(
			"DUE:20260701T090000Z",
			"RRULE:FREQ=WEEKLY;UNTIL=20260715T090000Z",
		);
		expect(roll(todo, "2026-07-02T00:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-08T09:00:00+00:00");
		// One occurrence left (07-15); after it the rule is exhausted.
		expect(roll(todo, "2026-07-20T00:00:00Z")).toBe(false);
	});

	test("UNTIL is inclusive", () => {
		const todo = parseVtodo(
			"DUE:20260701T090000Z",
			"RRULE:FREQ=WEEKLY;UNTIL=20260715T090000Z",
		);
		expect(roll(todo, "2026-07-08T10:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-15T09:00:00+00:00");
	});

	test("a DATE UNTIL on an all-day task", () => {
		const todo = parseVtodo(
			"DUE;VALUE=DATE:20260601",
			"RRULE:FREQ=MONTHLY;UNTIL=20260801",
		);
		expect(roll(todo, "2026-07-02T00:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-08-01");
		expect(roll(todo, "2026-08-02T00:00:00Z")).toBe(false);
	});
});

describe("time zones", () => {
	test("a TZID task keeps its zone", () => {
		const todo = parseVtodo(
			"DTSTART;TZID=Europe/Sofia:20260701T090000",
			"DUE;TZID=Europe/Sofia:20260701T090000",
			"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
		);
		expect(roll(todo, "2026-07-01T12:00:00Z")).toBe(true); // past 09:00 Sofia
		expect(decoded(todo, "DUE")).toBe("2026-07-13T09:00:00+03:00");
		expect(todo.toString()).toContain("TZID=Europe/Sofia");
	});

	test("a DST crossing keeps the wall clock", () => {
		// EEST (+03) ends 2026-10-25: 09:00 stays 09:00, the offset shifts.
		const todo = parseVtodo(
			"DUE;TZID=Europe/Sofia:20261020T090000",
			"RRULE:FREQ=WEEKLY;BYDAY=TU",
		);
		expect(roll(todo, "2026-10-21T00:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-10-27T09:00:00+02:00");
	});

	test("now is an instant (Python's naive-now-as-UTC case)", () => {
		const todo = parseVtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-03T12:00:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-04T05:45:00+00:00");
	});

	test("all-day roll-forward uses the local Sofia day, not UTC", () => {
		// 2026-07-15 23:30 UTC is already 07-16 02:30 in Sofia (EEST): the next
		// occurrence is computed in local time (07-17), never UTC (07-16).
		const todo = parseVtodo("DUE;VALUE=DATE:20260715", "RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-15T23:30:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-17");
	});

	test("the all-day local zone is configurable", () => {
		// The same instant with the zone set to UTC rolls only to 07-16.
		const todo = parseVtodo("DUE;VALUE=DATE:20260715", "RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-15T23:30:00Z", "UTC")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-16");
	});

	test("a floating timed task compares now in the local zone", () => {
		// 06:30 UTC is 09:30 in Sofia: the 09:00 floating occurrence is past.
		const todo = parseVtodo("DUE:20260701T090000", "RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-01T06:30:00Z")).toBe(true);
		expect(decoded(todo, "DUE")).toBe("2026-07-02T09:00:00");
	});
});

describe("DTSTART / DUE combinations", () => {
	test("DTSTART and DUE move together, keeping the duration", () => {
		const todo = parseVtodo(
			"DTSTART:20260701T080000Z",
			"DUE:20260701T090000Z", // one hour after DTSTART
			"RRULE:FREQ=DAILY",
		);
		expect(roll(todo, "2026-07-01T12:00:00Z")).toBe(true);
		expect(decoded(todo, "DTSTART")).toBe("2026-07-02T08:00:00+00:00");
		expect(decoded(todo, "DUE")).toBe("2026-07-02T09:00:00+00:00");
	});

	test("a same-zone duration is kept on the wall clock across DST", () => {
		// Python subtracts datetimes sharing a tzinfo on the wall clock: 2d22h
		// here, although the instants are 2d23h apart (EDT to EST).
		const todo = parseVtodo(
			"DTSTART;TZID=America/New_York:20271104T130000",
			"DUE;TZID=America/New_York:20271107T110000",
			"RRULE:FREQ=DAILY;INTERVAL=3",
		);
		expect(roll(todo, "2027-11-01T13:11:00Z", "UTC")).toBe(true);
		expect(decoded(todo, "DTSTART")).toBe("2027-11-07T13:00:00-05:00");
		expect(decoded(todo, "DUE")).toBe("2027-11-10T11:00:00-05:00");
	});

	test("DTSTART only rolls DTSTART", () => {
		const todo = parseVtodo("DTSTART:20260701T080000Z", "RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-01T12:00:00Z")).toBe(true);
		expect(decoded(todo, "DTSTART")).toBe("2026-07-02T08:00:00+00:00");
		expect(todo.getFirstProperty("due")).toBeNull();
	});
});

describe("not recurring / degenerate", () => {
	test("no RRULE returns false", () => {
		const todo = parseVtodo("DUE:20260701T054500Z");
		expect(roll(todo, "2026-07-03T00:00:00Z")).toBe(false);
	});

	test("an RRULE without any date returns false", () => {
		const todo = parseVtodo("RRULE:FREQ=DAILY");
		expect(roll(todo, "2026-07-03T00:00:00Z")).toBe(false);
	});

	test("nextOccurrence is null when exhausted", () => {
		const todo = parseVtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=1");
		const recur = todo.getFirstPropertyValue("rrule") as IcalRecur;
		const base = todo.getFirstPropertyValue("due") as IcalTime;
		expect(
			nextOccurrence(recur, base, new Date("2026-08-01T00:00:00Z"), SOFIA),
		).toBeNull();
	});

	test("a rule dateutil cannot parse raises RecurrenceError", () => {
		// ical.js drops unknown recur parts that dateutil refused; the port
		// checks the raw rule so it still surfaces RecurrenceError.
		const todo = parseVtodo(
			"DUE:20260701T054500Z",
			"RRULE:FREQ=DAILY;X-BOGUS=1",
		);
		expect(() => roll(todo, "2026-07-03T00:00:00Z")).toThrow(RecurrenceError);
	});

	test("a rule without FREQ raises RecurrenceError", () => {
		const todo = parseVtodo("DUE:20260701T054500Z", "RRULE:COUNT=3");
		expect(() => roll(todo, "2026-07-03T00:00:00Z")).toThrow(RecurrenceError);
	});
});

// -- property: COUNT bookkeeping matches a closed-form oracle

const BASE_MS = Date.UTC(2026, 6, 1, 6, 30);
type Freq = "DAILY" | "WEEKLY" | "MONTHLY";

/** Occurrence k of FREQ;INTERVAL from 2026-07-01T06:30Z (day 1, so months never skip). */
function oracleOccurrence(freq: Freq, interval: number, k: number): number {
	if (freq === "DAILY") return BASE_MS + k * interval * 86_400_000;
	if (freq === "WEEKLY") return BASE_MS + k * interval * 7 * 86_400_000;
	return Date.UTC(2026, 6 + k * interval, 1, 6, 30);
}

function oracleAll(
	freq: Freq,
	interval: number,
	count: number,
	startMs = BASE_MS,
): number[] {
	const out: number[] = [];
	for (let k = 0; out.length < count; k++) {
		const t = oracleOccurrence(freq, interval, k);
		if (t >= startMs) out.push(t);
	}
	return out;
}

const pyIso = (ms: number) =>
	new Date(ms).toISOString().replace(".000Z", "+00:00");

describe("property", () => {
	test("roll-forward matches the oracle and never stretches the rule", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<Freq>("DAILY", "WEEKLY", "MONTHLY"),
				fc.integer({ min: 1, max: 4 }),
				fc.integer({ min: 2, max: 30 }),
				fc.integer({ min: 0, max: 200 }),
				(freq, interval, count, daysLate) => {
					const rule = `FREQ=${freq};INTERVAL=${interval};COUNT=${count}`;
					const todo = parseVtodo("DUE:20260701T063000Z", `RRULE:${rule}`);
					const nowMs = BASE_MS + daysLate * 86_400_000 + 3_600_000;
					const all = oracleAll(freq, interval, count);
					const expectedNext = all.find((t) => t > Math.max(nowMs, BASE_MS));

					const rolled = rollForward(todo, new Date(nowMs), SOFIA);
					if (expectedNext === undefined) {
						expect(rolled).toBe(false);
						expect(ruleText(todo)).toBe(rule); // preserved verbatim
						return;
					}
					expect(rolled).toBe(true);
					expect(decoded(todo, "DUE")).toBe(pyIso(expectedNext));

					// The rolled rule's final occurrence equals the original's:
					// decrementing COUNT by the consumed occurrences never
					// stretches the rule.
					const newCount = Number(/COUNT=(\d+)/.exec(ruleText(todo))?.[1]);
					expect(newCount).toBeGreaterThanOrEqual(1);
					const consumed = all.filter((t) => t < expectedNext).length;
					expect(newCount).toBe(count - consumed);
					expect(all.at(-1)).toBe(
						oracleAll(freq, interval, consumed + newCount).at(-1),
					);
				},
			),
			{ numRuns: 200 },
		);
	});
});
