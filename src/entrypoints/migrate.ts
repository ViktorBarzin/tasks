/**
 * Migrate entrypoint, bundled with `bun build --target bun` into
 * .output/entrypoints/migrate.js and run as the Deployment's init container:
 *
 *   bun .output/entrypoints/migrate.js
 *
 * Env: DATABASE_URL, DATABASE_PASSWORD_FILE (optional), MIGRATIONS_DIR
 * (defaults to ./drizzle relative to the working directory).
 */
import { resolve } from "node:path";
import { getLogger } from "@viktorbarzin/log";
import { runMigrateCli } from "@viktorbarzin/pg";

import { baselineStep, MIGRATION_LOCK_KEY } from "#/server/db/migrate.server";

process.exitCode = await runMigrateCli({
	lockKey: MIGRATION_LOCK_KEY,
	beforeMigrate: baselineStep(resolve(process.env.MIGRATIONS_DIR || "drizzle")),
	logger: getLogger("tasks.migrate"),
});
