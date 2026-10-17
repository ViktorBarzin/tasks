/**
 * HTTP tests against the built server (`bun run build` first), on the helpers
 * from @viktorbarzin/auth/testing: tasks' entry point, a throwaway database
 * migrated with tasks' own migrator, and the mock Authentik set up the way
 * infra names the tasks client and groups.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	type BuiltServer,
	type MockAuthentik,
	startMockAuthentik,
	startBuiltServer as startServer,
} from "@viktorbarzin/auth/testing";
import { createSqlClient } from "@viktorbarzin/pg";
import {
	createTestDatabase,
	type TestDatabase,
} from "@viktorbarzin/pg/testing";

import { migrate } from "../server/db/migrate.server";
import { migrationsFolder } from "./postgres.server";

export {
	type BuiltServer,
	CookieJar,
	follow,
	type MockAuthentik,
} from "@viktorbarzin/auth/testing";

export const APP_DIR = resolve(import.meta.dir, "../..");
export const SERVER_ENTRY = resolve(APP_DIR, ".output/server/index.mjs");

export function builtServerExists(): boolean {
	return existsSync(SERVER_ENTRY);
}

/** Start the built tasks server with `env`; PUBLIC_ORIGINS etc. may depend on the port. */
export function startBuiltServer(
	env: Record<string, string>,
	options: { origin?: (port: number) => Record<string, string> } = {},
): Promise<BuiltServer> {
	return startServer({
		entry: SERVER_ENTRY,
		cwd: APP_DIR,
		env,
		...(options.origin ? { origin: options.origin } : {}),
	});
}

/** A new database on `adminUrl`; `migrated` runs tasks' migrations on it first. */
export async function testDatabase(
	adminUrl: string,
	opts: { before?: (url: string) => Promise<void>; migrated?: boolean } = {},
): Promise<TestDatabase> {
	const database = await createTestDatabase({ adminUrl, prefix: "tasks_test" });
	await opts.before?.(database.url);
	if (opts.migrated !== false) {
		const migrator = createSqlClient(
			{ url: database.url, passwordFile: null },
			{ max: 1 },
		);
		try {
			await migrate(migrator, migrationsFolder);
		} finally {
			await migrator.close();
		}
	}
	return database;
}

/** The mock Authentik with the tasks client id and users group. */
export function startTasksAuthentik(): Promise<MockAuthentik> {
	return startMockAuthentik({
		clientId: "tasks-web",
		slug: "tasks",
		usersGroup: "Tasks Users",
	});
}
