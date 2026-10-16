/**
 * Shared test fixtures for anything that talks CalDAV: the golden ICS files
 * and the seeded fake Nextcloud. Port of backend/tests/conftest.py (the
 * CalDAV half; the database and HTTP client fixtures live with their owners).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FakeNextcloud } from "./fake-nextcloud.server";

export const GOLDEN_DIR = join(import.meta.dir, "..", "fixtures", "golden");

export const NC_USER = "viktor-nc";
export const NC_PASS = "correct-horse-battery";
/** The DAV root the engine is configured with in tests (production's value). */
export const BASE_URL = "https://nextcloud.viktorbarzin.me/remote.php/dav";

export const GOLDENS = [
	"apple_recurring_alarm.ics",
	"apple_allday_until.ics",
	"apple_daily_count.ics",
	"nextcloud_simple.ics",
] as const;
export type GoldenName = (typeof GOLDENS)[number];

/** Golden ICS as it travels on the wire (the repo stores LF; CalDAV speaks CRLF). */
export function loadGolden(name: GoldenName): string {
	const raw = readFileSync(join(GOLDEN_DIR, name), "utf8");
	return raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/** RFC 5545 unfolding: one string per logical property line. */
export function unfoldLines(ics: string): string[] {
	return ics
		.replace(/\r\n[ \t]/g, "")
		.split("\r\n")
		.filter((line) => line !== "");
}

/**
 * A Nextcloud with one account, two task Lists (plus a VEVENT-only calendar)
 * and realistic Apple/Nextcloud seed data: conftest.py's `fake_nc`.
 */
export function seededFakeNextcloud(): FakeNextcloud {
	const fake = new FakeNextcloud();
	fake.addUser(NC_USER, NC_PASS);
	fake.addCalendar(NC_USER, "personal", "Personal");
	fake.addCalendar(NC_USER, "work", "Work");
	fake.addCalendar(NC_USER, "contact_birthdays", "Birthdays", ["VEVENT"]);
	fake.putIcs(
		NC_USER,
		"personal",
		"6FD37E05-9AF0-4C0B-A9E9-D3B0E0F1A2B3.ics",
		loadGolden("apple_recurring_alarm.ics"),
	);
	fake.putIcs(
		NC_USER,
		"personal",
		"0D9E1F2A-3B4C-5D6E-7F80-91A2B3C4D5E6.ics",
		loadGolden("apple_allday_until.ics"),
	);
	fake.putIcs(
		NC_USER,
		"personal",
		"11C0FFEE-AAAA-BBBB-CCCC-000000000001.ics",
		loadGolden("apple_daily_count.ics"),
	);
	fake.putIcs(
		NC_USER,
		"work",
		"nc-web-3f2a1b4c5d6e.ics",
		loadGolden("nextcloud_simple.ics"),
	);
	return fake;
}
