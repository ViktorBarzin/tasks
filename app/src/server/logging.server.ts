/**
 * JSON-lines logging (backend/tasks_api/logging_setup.py): one JSON object per
 * line on stderr with `ts`, `level`, `logger`, `msg`, then any extras passed at
 * the call site, then `exc` for an error. Extras never overwrite the four
 * standard keys. Loki and the existing dashboards parse this shape.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";
export type LogExtra = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = {
	DEBUG: 10,
	INFO: 20,
	WARNING: 30,
	ERROR: 40,
};

type Sink = (line: string) => void;

let sink: Sink = (line) => {
	process.stderr.write(`${line}\n`);
};
let threshold: number = LEVEL_RANK[parseLevel(process.env.LOG_LEVEL)];

function parseLevel(raw: string | undefined): LogLevel {
	const upper = (raw ?? "INFO").toUpperCase();
	if (upper === "WARN") return "WARNING";
	return upper in LEVEL_RANK ? (upper as LogLevel) : "INFO";
}

/** Python's `datetime.isoformat()` for an aware UTC datetime: `...T04:05:06.789000+00:00`. */
export function pythonIsoTimestamp(date: Date): string {
	return date.toISOString().replace("Z", "000+00:00");
}

/** Test hook: capture lines instead of writing to stderr. Returns a restore function. */
export function setLogSink(next: Sink): () => void {
	const previous = sink;
	sink = next;
	return () => {
		sink = previous;
	};
}

export function setLogLevel(level: LogLevel): void {
	threshold = LEVEL_RANK[level];
}

function jsonReplacer(_key: string, value: unknown): unknown {
	// Python's json.dumps(default=str) stringifies what JSON cannot carry.
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) return String(value);
	return value;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	return String(err);
}

export function formatRecord(
	level: LogLevel,
	logger: string,
	msg: string,
	extra?: LogExtra,
	err?: unknown,
	now: Date = new Date(),
): string {
	const payload: Record<string, unknown> = {
		ts: pythonIsoTimestamp(now),
		level,
		logger,
		msg,
	};
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (!(key in payload)) payload[key] = value;
		}
	}
	if (err !== undefined) payload.exc = formatError(err);
	return JSON.stringify(payload, jsonReplacer);
}

export interface Logger {
	debug(msg: string, extra?: LogExtra): void;
	info(msg: string, extra?: LogExtra): void;
	warning(msg: string, extra?: LogExtra): void;
	error(msg: string, extra?: LogExtra): void;
	/** ERROR with the error's stack under `exc`, like Python's logger.exception. */
	exception(msg: string, err: unknown, extra?: LogExtra): void;
	/** Any level, with an optional error under `exc`. */
	record(level: LogLevel, msg: string, extra?: LogExtra, err?: unknown): void;
}

export function getLogger(name: string): Logger {
	const emit = (
		level: LogLevel,
		msg: string,
		extra?: LogExtra,
		err?: unknown,
	) => {
		if (LEVEL_RANK[level] < threshold) return;
		sink(formatRecord(level, name, msg, extra, err));
	};
	return {
		debug: (msg, extra) => emit("DEBUG", msg, extra),
		info: (msg, extra) => emit("INFO", msg, extra),
		warning: (msg, extra) => emit("WARNING", msg, extra),
		error: (msg, extra) => emit("ERROR", msg, extra),
		exception: (msg, err, extra) => emit("ERROR", msg, extra, err),
		record: emit,
	};
}
