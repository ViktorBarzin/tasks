/**
 * Schema migrations, run once per deploy by the migrate entrypoint
 * (src/entrypoints/migrate.ts) as an init container. @viktorbarzin/pg runs
 * drizzle's migrator under a session `pg_advisory_lock`; this module adds the
 * tasks-only baseline step that runs under the same lock.
 *
 * Baseline: drizzle/0000_baseline.sql was pulled from the schema Alembic
 * created. On a database that Alembic manages (public.alembic_version exists)
 * and that Drizzle has never migrated, the baseline is recorded as applied
 * without running it, using the same hash and timestamp drizzle-orm's
 * migrator would write. A fresh database runs the baseline normally.
 */
import { getLogger } from "@viktorbarzin/log";
import { runMigrations } from "@viktorbarzin/pg";
import type { SQL } from "bun";
import { readMigrationFiles } from "drizzle-orm/migrator";

const log = getLogger("tasks.migrate");

/** Fixed advisory-lock key for this app's migrations: the bytes of "tasksmig". */
export const MIGRATION_LOCK_KEY = 0x7461736b736d6967n;

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

/** The `beforeMigrate` step for @viktorbarzin/pg. */
export function baselineStep(migrationsFolder: string) {
	return async (client: SQL): Promise<void> => {
		if (await markBaselineIfLegacy(client, migrationsFolder))
			log.info("recorded the pulled baseline as applied on the Alembic schema");
	};
}

/** Migrate with the tasks lock key and baseline step. The client must have max 1. */
export function migrate(client: SQL, migrationsFolder: string) {
	return runMigrations(client, {
		migrationsFolder,
		lockKey: MIGRATION_LOCK_KEY,
		beforeMigrate: baselineStep(migrationsFolder),
		logger: log,
	});
}
