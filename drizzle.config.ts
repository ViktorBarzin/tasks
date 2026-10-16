import { defineConfig } from "drizzle-kit";

// drizzle-kit is a dev tool: `db:generate` needs no database; `db:pull` and
// `db:studio` need DATABASE_URL with the password inline (local only).
// The running app and the migrate entrypoint read the password from a file
// instead (src/server/db/client.server.ts).
export default defineConfig({
	dialect: "postgresql",
	// The Alembic tables, then the identity tables (additive, new in the TypeScript build).
	schema: [
		"./src/server/db/schema.server.ts",
		"./src/server/auth/schema.server.ts",
	],
	out: "./drizzle",
	schemaFilter: ["public"],
	// Alembic's bookkeeping table stays Alembic's while the Python image is a
	// rollback target (ADR-0001, Pilot / Data).
	tablesFilter: ["!alembic_version"],
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
});
