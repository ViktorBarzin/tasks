import { expect, test } from "bun:test";

import {
	formatRecord,
	getLogger,
	pythonIsoTimestamp,
	setLogLevel,
	setLogSink,
} from "./logging.server";

test("a record has ts, level, logger, msg, then extras, like logging_setup.py", () => {
	const line = formatRecord(
		"INFO",
		"tasks.sync",
		"sync served",
		{ user: "viktor", full: true, lists: 3 },
		undefined,
		new Date("2026-10-16T04:05:06.789Z"),
	);
	expect(line).toBe(
		'{"ts":"2026-10-16T04:05:06.789000+00:00","level":"INFO","logger":"tasks.sync","msg":"sync served","user":"viktor","full":true,"lists":3}',
	);
});

test("extras never overwrite the standard keys", () => {
	const record = JSON.parse(
		formatRecord("INFO", "a", "real", { msg: "fake", level: "DEBUG", x: 1 }),
	);
	expect(record).toMatchObject({ level: "INFO", msg: "real", x: 1 });
});

test("exception() adds the stack under exc", () => {
	const lines: string[] = [];
	const restore = setLogSink((l) => lines.push(l));
	setLogLevel("DEBUG");
	try {
		getLogger("t").exception("boom", new Error("bad"), { path: "/api/ops" });
	} finally {
		restore();
		setLogLevel("WARNING");
	}
	const record = JSON.parse(lines[0] ?? "{}");
	expect(record).toMatchObject({
		level: "ERROR",
		msg: "boom",
		path: "/api/ops",
	});
	expect(record.exc).toContain("Error: bad");
});

test("records below the threshold are dropped", () => {
	const lines: string[] = [];
	const restore = setLogSink((l) => lines.push(l));
	setLogLevel("WARNING");
	try {
		getLogger("t").info("quiet");
		getLogger("t").warning("loud");
	} finally {
		restore();
	}
	expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["loud"]);
});

test("timestamps match Python's isoformat for UTC", () => {
	expect(pythonIsoTimestamp(new Date("2026-01-02T03:04:05.006Z"))).toBe(
		"2026-01-02T03:04:05.006000+00:00",
	);
});
