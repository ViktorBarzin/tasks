/**
 * The telemetry env contract (tasks ADR-0005), as infra
 * stacks/tasks/telemetry.tf and the tanstack_app module set it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serviceInfo, telemetrySettings } from "./config.server";

const NAMES = [
	"NODE_ENV",
	"TELEMETRY",
	"TELEMETRY_WRITE_KEY",
	"TELEMETRY_WRITE_KEY_FILE",
	"TELEMETRY_HOST",
	"TELEMETRY_ENVIRONMENT",
	"SENTRY_DSN",
	"SENTRY_BROWSER_DSN",
	"SERVICE_VERSION",
] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

function setEnv(values: Partial<Record<(typeof NAMES)[number], string>>) {
	for (const name of NAMES) {
		const value = values[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

afterEach(() => {
	for (const name of NAMES) {
		const value = saved[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("serviceInfo", () => {
	test("names the app and takes the version from the image", () => {
		setEnv({ SERVICE_VERSION: "1a2b3c4d", NODE_ENV: "test" });
		expect(serviceInfo()).toEqual({
			name: "tasks",
			version: "1a2b3c4d",
			environment: "dev",
		});
	});

	test("is production under NODE_ENV=production unless TELEMETRY_ENVIRONMENT says otherwise", () => {
		setEnv({ NODE_ENV: "production" });
		expect(serviceInfo()).toEqual({
			name: "tasks",
			version: "dev",
			environment: "production",
		});
		setEnv({ NODE_ENV: "production", TELEMETRY_ENVIRONMENT: "staging" });
		expect(serviceInfo().environment).toBe("staging");
	});
});

describe("telemetrySettings", () => {
	test("is off without a write key", () => {
		setEnv({});
		expect(telemetrySettings()).toBeNull();
	});

	test("is off with TELEMETRY=off, even with a write key", () => {
		setEnv({ TELEMETRY_WRITE_KEY: "wk", TELEMETRY: "OFF" });
		expect(telemetrySettings()).toBeNull();
	});

	test("reads the infra env contract", () => {
		setEnv({
			NODE_ENV: "production",
			SERVICE_VERSION: "1a2b3c4d",
			TELEMETRY_WRITE_KEY: "wk",
			TELEMETRY_HOST: "http://pipeline.test",
			TELEMETRY_ENVIRONMENT: "production",
			SENTRY_DSN: "http://key@glitchtip.test/15",
			SENTRY_BROWSER_DSN: "https://key@tasks.example/_t/x/15",
		});
		expect(telemetrySettings()).toEqual({
			writeKey: "wk",
			host: "http://pipeline.test",
			siteId: "1",
			serverDsn: "http://key@glitchtip.test/15",
			browserDsn: "https://key@tasks.example/_t/x/15",
			productionHosts: ["viktorbarzin.me"],
			release: "1a2b3c4d",
			environment: "production",
		});
	});

	test("defaults to the in-cluster pipeline and no DSNs, and reads the key from a file", () => {
		const file = join(mkdtempSync(join(tmpdir(), "tasks-telemetry-")), "key");
		writeFileSync(file, "from-file\n");
		setEnv({ TELEMETRY_WRITE_KEY_FILE: file });
		expect(telemetrySettings()).toMatchObject({
			writeKey: "from-file",
			host: "http://event-pipeline.rybbit.svc.cluster.local",
			serverDsn: null,
			browserDsn: null,
		});
	});
});
