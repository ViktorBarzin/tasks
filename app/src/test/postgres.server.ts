/**
 * Throwaway Postgres databases for tests, migrated with the app's own
 * migrations. Tests that use this skip unless TEST_DATABASE_URL points at a
 * server where that role may create databases (recipe in
 * src/server/db/db.server.test.ts).
 */
import { resolve } from "node:path";
import { SQL } from "bun";

import { createDb, type Db } from "../server/db/client.server";
import { runMigrations } from "../server/db/migrate.server";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const migrationsFolder = resolve(import.meta.dir, "../../drizzle");

export interface TestDatabase {
	url: string;
	client: SQL;
	db: Db;
	/** Close the client and drop the database. */
	drop(): Promise<void>;
}

export async function migratedTestDatabase(): Promise<TestDatabase> {
	if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set");
	const name = `tasks_test_${crypto.randomUUID().replaceAll("-", "")}`;
	const admin = new SQL(testDatabaseUrl);
	await admin.unsafe(`create database ${name}`);
	await admin.close();
	const url = new URL(testDatabaseUrl);
	url.pathname = `/${name}`;
	const client = new SQL({ url: url.toString(), max: 2 });
	await runMigrations(client, migrationsFolder);
	return {
		url: url.toString(),
		client,
		db: createDb(client),
		async drop() {
			await client.close();
			const cleanup = new SQL(testDatabaseUrl ?? "");
			await cleanup.unsafe(`drop database if exists ${name} with (force)`);
			await cleanup.close();
		},
	};
}
