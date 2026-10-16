/**
 * Drizzle schema for the two tables the retired Python build created with
 * Alembic. It must match the live database exactly: the baseline in
 * drizzle/0000_baseline.sql was pulled from it, and `bun run db:generate`
 * reports "No schema changes" while the two agree.
 */
import {
	customType,
	pgTable,
	primaryKey,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";

/**
 * `bytea`, written by hand because drizzle-kit cannot introspect it.
 *
 * `enc_app_password` holds the ASCII bytes of a Fernet token (base64url text),
 * exactly as Python's `Fernet.encrypt()` returned them, so rows written by the
 * retired Python build still decrypt. See src/server/crypto/fernet.server.ts.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
	dataType() {
		return "bytea";
	},
	toDriver(value) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	},
	fromDriver(value) {
		return new Uint8Array(value);
	},
});

/** A household user's link between their identity and their Nextcloud account (tasks ADR-0002). */
export const connectedAccounts = pgTable("connected_accounts", {
	/** The account key from src/server/auth/user.server.ts (`AuthUser.accountKey`). */
	authentikUsername: varchar("authentik_username", {
		length: 255,
	}).primaryKey(),
	ncUsername: varchar("nc_username", { length: 255 }).notNull(),
	encAppPassword: bytea("enc_app_password").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	// SQLAlchemy's onupdate was ORM-side too: there is no trigger in the database.
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull()
		.$onUpdate(() => new Date()),
});

/** Idempotency journal: one row per op ever applied or deduplicated. */
export const appliedOps = pgTable(
	"applied_ops",
	{
		authentikUsername: varchar("authentik_username", { length: 255 }).notNull(),
		opId: varchar("op_id", { length: 255 }).notNull(),
		kind: varchar("kind", { length: 32 }).notNull(),
		status: varchar("status", { length: 32 }).notNull(),
		appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.authentikUsername, table.opId],
			name: "applied_ops_pkey",
		}),
	],
);

export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert;
export type AppliedOp = typeof appliedOps.$inferSelect;
export type NewAppliedOp = typeof appliedOps.$inferInsert;
