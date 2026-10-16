/**
 * Schema migrations, run once per deploy by the migrate entrypoint
 * (src/entrypoints/migrate.ts) as an init container or Job.
 *
 * drizzle-orm's migrator takes no lock of its own, so this module holds a
 * session-level `pg_advisory_lock` around it (ADR-0001, Data / Migrations).
 * The client passed in must have a pool of exactly one connection: the lock,
 * the migrator's transaction and the unlock then share one session.
 *
 * Baseline: drizzle/0000_baseline.sql was pulled from the schema Alembic
 * created. On a database that Alembic manages (public.alembic_version exists)
 * and that Drizzle has never migrated, the baseline is recorded as applied
 * without running it, using the same hash and timestamp drizzle-orm's
 * migrator would write. A fresh database runs the baseline normally.
 */
import type { SQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { getLogger } from "../logging.server";
import { createDb } from "./client.server";

const log = getLogger("tasks.migrate");

/** Fixed advisory-lock key for this app's migrations: the bytes of "tasksmig". */
export const MIGRATION_LOCK_KEY = 0x7461736b736d6967n;

export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface MigrateResult {
	baselineMarked: boolean;
	applied: number;
}

async function appliedCount(client: SQL): Promise<number> {
	const [row] = await client`
		select count(*)::int as n from drizzle.__drizzle_migrations`;
	return (row as { n: number }).n;
}

/**
 * Record the baseline as applied when Alembic already created its tables.
 * Must run under the migration lock. Returns true when it inserted the row.
 */
export async function markBaselineIfLegacy(
	client: SQL,
	migrationsFolder: string,
): Promise<boolean> {
	await client`create schema if not exists drizzle`;
	await client`
		create table if not exists drizzle.__drizzle_migrations (
			id serial primary key,
			hash text not null,
			created_at bigint
		)`;
	if ((await appliedCount(client)) > 0) return false;

	const [legacy] = await client`
		select to_regclass('public.alembic_version') is not null as alembic,
		       to_regclass('public.connected_accounts') is not null as accounts`;
	const { alembic, accounts } = legacy as {
		alembic: boolean;
		accounts: boolean;
	};
	if (!alembic || !accounts) return false;

	const [baseline] = readMigrationFiles({ migrationsFolder });
	if (!baseline) throw new Error(`no migrations in ${migrationsFolder}`);
	await client`
		insert into drizzle.__drizzle_migrations (hash, created_at)
		values (${baseline.hash}, ${baseline.folderMillis})`;
	return true;
}

export async function runMigrations(
	client: SQL,
	migrationsFolder: string,
): Promise<MigrateResult> {
	log.info("waiting for migration lock", { lock_key: MIGRATION_LOCK_KEY });
	await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
	try {
		const baselineMarked = await markBaselineIfLegacy(client, migrationsFolder);
		if (baselineMarked) {
			log.info("recorded the pulled baseline as applied on the Alembic schema");
		}
		const before = await appliedCount(client);
		await migrate(createDb(client), {
			migrationsFolder,
			migrationsSchema: MIGRATIONS_SCHEMA,
			migrationsTable: MIGRATIONS_TABLE,
		});
		const applied = (await appliedCount(client)) - before;
		log.info("migrations complete", {
			applied,
			baseline_marked: baselineMarked,
		});
		return { baselineMarked, applied };
	} finally {
		await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
	}
}
