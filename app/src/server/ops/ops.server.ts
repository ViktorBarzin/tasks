/**
 * POST /api/ops: replay a batch of client ops against Nextcloud.
 * Port of backend/tasks_api/routers/ops.py.
 *
 * Guarantees, per the contract (docs/2026-07-03-review-fixes-contract-delta.md):
 * - in order: ops apply sequentially, one result each;
 * - idempotent: an op_id already in applied_ops, or an existing create UID
 *   (`If-None-Match: *`), returns `duplicate`, never a double apply;
 * - Silent LWW: a 412 on a stale ETag refetches, re-applies the op's own
 *   fields and PUTs again (up to 3 attempts), reported as `lww_reapplied`;
 * - an unknown kind is a per-op `error`, never a whole-batch 422;
 * - CalDAVTransient stops the batch: that op is `retry`, later ops are omitted;
 * - CalDAVUnauthorized aborts the batch with the 401 `nextcloud_unauthorized`
 *   envelope (rethrow it);
 * - each applied op is journaled in applied_ops (authentik_username = the
 *   account key); a unique-violation on insert means another request journaled
 *   it first, and the result is `duplicate`.
 * After a batch that applied at least one op, poke the user's other devices
 * (src/server/realtime/notify.server.ts).
 */
import type { OpsResponse, WireOp } from "#/shared/contract";
import type { CalDAVEngine } from "../caldav/engine.server";
import type { Db } from "../db/client.server";
import { notImplemented } from "../not-implemented.server";

/** Valid `list_create` ids: client-generated and URL-safe. */
export const LIST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const MAX_ETAG_RETRIES = 3;

export interface ApplyOpsContext {
	db: Db;
	engine: CalDAVEngine;
	accountKey: string;
	/** Batch start time; Python used one `now` for the whole batch. */
	now: Date;
}

export async function applyOps(
	ctx: ApplyOpsContext,
	ops: WireOp[],
): Promise<OpsResponse> {
	void ops;
	return notImplemented(`applyOps(${ctx.accountKey})`);
}
