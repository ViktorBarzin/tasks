/**
 * The app's pool (@viktorbarzin/pg): Drizzle on Bun's built-in SQL client,
 * at most 4 connections plus the realtime LISTEN connection (5 per pod, the
 * ADR-0001 budget), lazy, once per process. The password is read from
 * DATABASE_PASSWORD_FILE on every new connection, so a Vault rotation does
 * not break new connections.
 */

import { createPool } from "@viktorbarzin/pg";
import type { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";

import { pgSettings } from "../config.server";
import * as schema from "./schema.server";

export const pool = createPool({ settings: pgSettings, schema });

export type Db = BunSQLDatabase<typeof schema>;

/** A Drizzle database on a client of the caller's (tests). */
export function createDb(client: SQL): Db {
	return drizzle({ client, schema });
}

/** The app's shared pool. */
export function getDb(): Db {
	return pool.getDb();
}
