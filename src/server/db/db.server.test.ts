/**
 * Database tests against a real Postgres. They run only when TEST_DATABASE_URL
 * points at a server where that role may create databases, e.g.
 *
 *   docker run -d --name tasks-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1::5432 postgres:16
 *   TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:<port>/postgres bun run test
 *
 * Each test creates and drops its own database.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { readMigrationFiles } from "drizzle-orm/migrator";

import python from "../crypto/fixtures/fernet-python.json";
import { accountPassword, getAccount, upsertAccount } from "./accounts.server";
import { createDb, createSqlClient } from "./client.server";
import { runMigrations } from "./migrate.server";

const adminUrl = process.env.TEST_DATABASE_URL;
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const MIGRATION_COUNT = readMigrationFiles({ migrationsFolder }).length;

/** The DDL Alembic 0001 + 0002 produce (backend/alembic/versions). */
const ALEMBIC_SCHEMA = `
CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num));
CREATE TABLE connected_accounts (
	authentik_username VARCHAR(255) NOT NULL,
	nc_username VARCHAR(255) NOT NULL,
	enc_app_password BYTEA NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (authentik_username)
);
CREATE TABLE applied_ops (
	authentik_username VARCHAR(255) NOT NULL,
	op_id VARCHAR(255) NOT NULL,
	kind VARCHAR(32) NOT NULL,
	status VARCHAR(32) NOT NULL,
	applied_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (authentik_username, op_id)
);
INSERT INTO alembic_version (version_num) VALUES ('0002');
`;

const created: string[] = [];

async function freshDatabase(): Promise<string> {
	const name = `tasks_test_${crypto.randomUUID().replaceAll("-", "")}`;
	const admin = new SQL(adminUrl ?? "");
	await admin.unsafe(`create database ${name}`);
	await admin.close();
	created.push(name);
	const url = new URL(adminUrl ?? "");
	url.pathname = `/${name}`;
	return url.toString();
}

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

function withDatabaseUrl<T>(url: string, fn: () => T): T {
	const previous = process.env.DATABASE_URL;
	process.env.DATABASE_URL = url;
	try {
		return fn();
	} finally {
		restoreEnv("DATABASE_URL", previous);
	}
}

afterAll(async () => {
	if (!adminUrl) return;
	const admin = new SQL(adminUrl);
	for (const name of created) {
		await admin.unsafe(`drop database if exists ${name} with (force)`);
	}
	await admin.close();
});

describe.skipIf(!adminUrl)("migrations", () => {
	test("on the Alembic schema, records the baseline without running it", async () => {
		const url = await freshDatabase();
		const setup = new SQL(url);
		await setup.unsafe(ALEMBIC_SCHEMA);
		await setup.close();

		const client = withDatabaseUrl(url, () => createSqlClient({ max: 1 }));
		const first = await runMigrations(client, migrationsFolder);
		const second = await runMigrations(client, migrationsFolder);
		const rows = await client`select hash from drizzle.__drizzle_migrations`;
		const [alembic] = await client`select version_num from alembic_version`;
		await client.close();

		// The baseline is recorded, not run; later (additive) migrations run.
		expect(first).toEqual({
			baselineMarked: true,
			applied: MIGRATION_COUNT - 1,
		});
		expect(second).toEqual({ baselineMarked: false, applied: 0 });
		expect(rows).toHaveLength(MIGRATION_COUNT);
		expect(alembic).toEqual({ version_num: "0002" });
	});

	test("on an empty database, runs every migration", async () => {
		const url = await freshDatabase();
		const client = withDatabaseUrl(url, () => createSqlClient({ max: 1 }));
		const result = await runMigrations(client, migrationsFolder);
		const tables = await client`
			select table_name from information_schema.tables
			where table_schema = 'public' order by table_name`;
		await client.close();

		expect(result).toEqual({ baselineMarked: false, applied: MIGRATION_COUNT });
		const names = tables.map((t: { table_name: string }) => t.table_name);
		expect(names).toContain("applied_ops");
		expect(names).toContain("connected_accounts");
	});

	test("two migrators started together apply each migration once", async () => {
		const url = await freshDatabase();
		const a = withDatabaseUrl(url, () => createSqlClient({ max: 1 }));
		const b = withDatabaseUrl(url, () => createSqlClient({ max: 1 }));
		const results = await Promise.all([
			runMigrations(a, migrationsFolder),
			runMigrations(b, migrationsFolder),
		]);
		const rows = await a`select hash from drizzle.__drizzle_migrations`;
		await Promise.all([a.close(), b.close()]);

		expect(results.map((r) => r.applied).sort()).toEqual([0, MIGRATION_COUNT]);
		expect(rows).toHaveLength(MIGRATION_COUNT);
	});
});

describe.skipIf(!adminUrl)("connected accounts", () => {
	test("reads a row the Python backend wrote, and upserts in place", async () => {
		const url = await freshDatabase();
		const client = withDatabaseUrl(url, () => createSqlClient({ max: 2 }));
		await runMigrations(client, migrationsFolder);
		// What SQLAlchemy stored: the Fernet token's ASCII bytes in bytea.
		await client`
			insert into connected_accounts (authentik_username, nc_username, enc_app_password)
			values ('viktor', 'viktor-nc', ${Buffer.from(python.random_token, "ascii")})`;
		const db = createDb(client);

		const before = await getAccount(db, "viktor");
		expect(before?.ncUsername).toBe("viktor-nc");
		expect(before && accountPassword(before, python.key)).toBe(
			python.plaintext,
		);

		const after = await upsertAccount(
			db,
			"viktor",
			"viktor2",
			"new-pass",
			python.key,
		);
		expect(after.ncUsername).toBe("viktor2");
		expect(accountPassword(after, python.key)).toBe("new-pass");
		expect(after.createdAt.getTime()).toBe(before?.createdAt.getTime() ?? 0);
		expect(after.updatedAt.getTime()).toBeGreaterThan(
			before?.updatedAt.getTime() ?? 0,
		);

		const [raw] = await client`
			select convert_from(enc_app_password, 'SQL_ASCII') as token
			from connected_accounts where authentik_username = 'viktor'`;
		expect((raw as { token: string }).token).toMatch(/^gAAAAA[A-Za-z0-9_=-]+$/);
		expect(await getAccount(db, "nobody")).toBeNull();
		await client.close();
	});

	test("reads the password from DATABASE_PASSWORD_FILE", async () => {
		const url = new URL(adminUrl ?? "");
		const password = decodeURIComponent(url.password);
		url.password = "";
		const dir = await mkdtemp(join(tmpdir(), "tasks-pw-"));
		const file = join(dir, "password");
		await writeFile(file, `${password}\n`);
		const previous = process.env.DATABASE_PASSWORD_FILE;
		process.env.DATABASE_PASSWORD_FILE = file;
		try {
			const client = withDatabaseUrl(url.toString(), () =>
				createSqlClient({ max: 1 }),
			);
			const [row] = await client`select 1 as one`;
			await client.close();
			expect(row).toEqual({ one: 1 });
		} finally {
			restoreEnv("DATABASE_PASSWORD_FILE", previous);
			await rm(dir, { recursive: true });
		}
	});
});
