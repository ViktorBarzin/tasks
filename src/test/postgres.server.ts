/**
 * Throwaway Postgres databases for tests, migrated with the app's own
 * migrations (@viktorbarzin/pg/testing). Tests that use this skip unless
 * TEST_DATABASE_URL points at a server where that role may create databases
 * (recipe in src/server/db/db.server.test.ts).
 */
import { resolve } from "node:path";
import { migratedTestDatabase as migrated } from "@viktorbarzin/pg/testing";
import type { SQL } from "bun";

import { createDb, type Db } from "../server/db/client.server";
import { MIGRATION_LOCK_KEY } from "../server/db/migrate.server";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export const migrationsFolder = resolve(import.meta.dir, "../../drizzle");

export interface TestDatabase {
	url: string;
	client: SQL;
	db: Db;
	/** Close the client and drop the database. */
	drop(): Promise<void>;
}

export async function migratedTestDatabase(): Promise<TestDatabase> {
	if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set");
	const database = await migrated({
		adminUrl: testDatabaseUrl,
		migrationsFolder,
		lockKey: MIGRATION_LOCK_KEY,
		prefix: "tasks_test",
	});
	return { ...database, db: createDb(database.client) };
}
