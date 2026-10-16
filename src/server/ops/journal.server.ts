/**
 * The applied_ops idempotency journal (backend/tasks_api/models.py AppliedOp):
 * one row per op ever applied or deduplicated, keyed by
 * (authentik_username = the account key, op_id). Ops reported `error` or
 * `retry` are never journaled, so a resend can still apply.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { OpStatus } from "#/shared/contract";
import type { Db } from "../db/client.server";
import { appliedOps } from "../db/schema.server";

export interface OpJournal {
	/** The subset of `opIds` already journaled for this account. */
	journaledOpIds(accountKey: string, opIds: string[]): Promise<Set<string>>;
	/**
	 * Journal one op. False when the row already exists: another request
	 * journaled it between the pre-check and now (the result is `duplicate`).
	 */
	record(
		accountKey: string,
		opId: string,
		kind: string,
		status: OpStatus,
	): Promise<boolean>;
}

export function drizzleJournal(db: Db): OpJournal {
	return {
		async journaledOpIds(accountKey, opIds) {
			const unique = [...new Set(opIds)];
			if (unique.length === 0) return new Set();
			const rows = await db
				.select({ opId: appliedOps.opId })
				.from(appliedOps)
				.where(
					and(
						eq(appliedOps.authentikUsername, accountKey),
						inArray(appliedOps.opId, unique),
					),
				);
			return new Set(rows.map((row) => row.opId));
		},

		async record(accountKey, opId, kind, status) {
			// ON CONFLICT DO NOTHING is the IntegrityError branch in ops.py,
			// without aborting anything: no row back means someone else won.
			const inserted = await db
				.insert(appliedOps)
				.values({ authentikUsername: accountKey, opId, kind, status })
				.onConflictDoNothing()
				.returning({ opId: appliedOps.opId });
			return inserted.length > 0;
		},
	};
}
