-- Baseline pulled with `drizzle-kit pull` from the schema Alembic created
-- (backend/alembic/versions/0001 + 0002). On the live database these tables
-- already exist: the migrate entrypoint records this migration as applied
-- without running it when it finds alembic_version (src/server/db/migrate.server.ts).
-- On a fresh database (tests, local dev) it runs normally.
CREATE TABLE "connected_accounts" (
	"authentik_username" varchar(255) PRIMARY KEY NOT NULL,
	"nc_username" varchar(255) NOT NULL,
	"enc_app_password" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applied_ops" (
	"authentik_username" varchar(255) NOT NULL,
	"op_id" varchar(255) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applied_ops_pkey" PRIMARY KEY("authentik_username","op_id")
);
