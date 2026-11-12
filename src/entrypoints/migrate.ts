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
import { getLogger, setLogService } from "@viktorbarzin/log";
import { runMigrateCli } from "@viktorbarzin/pg";

import { serviceInfo } from "#/server/config.server";
import { baselineStep, MIGRATION_LOCK_KEY } from "#/server/db/migrate.server";

// service.name, service.version and deployment.environment.name on the init
// container's lines too, as on the server's (ADR-0005).
setLogService(serviceInfo());

process.exitCode = await runMigrateCli({
	lockKey: MIGRATION_LOCK_KEY,
	beforeMigrate: baselineStep(resolve(process.env.MIGRATIONS_DIR || "drizzle")),
	logger: getLogger("tasks.migrate"),
});
