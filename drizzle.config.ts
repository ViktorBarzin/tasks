import { defineConfig } from "drizzle-kit";

// drizzle-kit is a dev tool: `db:generate` needs no database; `db:pull` and
// `db:studio` need DATABASE_URL with the password inline (local only).
// The running app and the migrate entrypoint read the password from a file
// instead (src/server/db/client.server.ts).
export default defineConfig({
	dialect: "postgresql",
	// The Alembic-created tables, the identity tables from @viktorbarzin/auth
	// (re-exported) and identity_links.
	schema: "./src/server/db/schema.server.ts",
	out: "./drizzle",
	schemaFilter: ["public"],
	// The retired Python build's bookkeeping table: left in place, never managed.
	tablesFilter: ["!alembic_version"],
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
});
