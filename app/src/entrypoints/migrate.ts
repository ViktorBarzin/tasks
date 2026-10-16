/**
 * Migrate entrypoint, bundled with `bun build --target bun` into
 * .output/entrypoints/migrate.js and run as an init container or Job:
 *
 *   bun .output/entrypoints/migrate.js
 *
 * Env: DATABASE_URL, DATABASE_PASSWORD_FILE (optional), MIGRATIONS_DIR
 * (defaults to ./drizzle relative to the working directory).
 */
import { resolve } from "node:path";

import { createSqlClient } from "#/server/db/client.server";
import { runMigrations } from "#/server/db/migrate.server";
import { getLogger } from "#/server/logging.server";

const log = getLogger("tasks.migrate");
const folder = resolve(process.env.MIGRATIONS_DIR ?? "drizzle");

// One connection, so the advisory lock and the migrator share a session.
const client = createSqlClient({ max: 1 });
try {
	await runMigrations(client, folder);
} catch (err) {
	log.exception("migration failed", err, { migrations_dir: folder });
	process.exitCode = 1;
} finally {
	await client.close();
}
