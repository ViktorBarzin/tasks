/**
 * Postgres access: Drizzle on Bun's built-in SQL client (`drizzle-orm/bun-sql`).
 *
 * - The password comes from DATABASE_PASSWORD_FILE, read each time a new
 *   connection opens, so a Vault rotation does not break new connections
 *   (ADR-0001, Data / Provisioning).
 * - The app pod keeps at most 5 connections (ADR-0001, Connection budget);
 *   the migrate entrypoint uses 1, CronJobs at most 2.
 * - Nothing connects at import time: the first `getDb()` call opens the pool.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { getDatabaseSettings } from "../config.server";
import { processSingleton } from "../singleton.server";
import * as schema from "./schema.server";

/**
 * ADR-0001 allows at most 5 connections per pod. The realtime LISTEN
 * connection (src/server/realtime/listener.server.ts) sits outside this pool,
 * so the pool takes 4 and a pod stays at 5 in all.
 */
export const APP_POOL_MAX = 4;

export interface SqlClientOptions {
	/** Pool size. Defaults to APP_POOL_MAX. */
	max?: number;
	/** Close connections idle for this many seconds. 0 keeps them. */
	idleTimeout?: number;
}

/** Reads the mounted password file. Exported for tests. */
export async function readPasswordFile(path: string): Promise<string> {
	const text = await Bun.file(path).text();
	return text.replace(/\r?\n$/, "");
}

export function createSqlClient(options: SqlClientOptions = {}): SQL {
	const { url, passwordFile } = getDatabaseSettings();
	return new SQL({
		url,
		max: options.max ?? APP_POOL_MAX,
		idleTimeout: options.idleTimeout ?? 0,
		...(passwordFile ? { password: () => readPasswordFile(passwordFile) } : {}),
	});
}

export function createDb(client: SQL) {
	return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

/** The pool, once per process (src/server/singleton.server.ts). */
const pool = processSingleton("db.pool", () => ({
	shared: null as { client: SQL; db: Db } | null,
}));

/** The app's shared pool (max APP_POOL_MAX connections). */
export function getDb(): Db {
	if (pool.shared === null) {
		const client = createSqlClient();
		pool.shared = { client, db: createDb(client) };
	}
	return pool.shared.db;
}

/** Close the shared pool (graceful shutdown, tests). */
export async function closeDb(): Promise<void> {
	if (pool.shared !== null) {
		const { client } = pool.shared;
		pool.shared = null;
		await client.close();
	}
}
