/**
 * Request + approve (ADR-0001, Identity and access / Sign-up), generalised
 * from f1-stream ADR-0042. A signed-in person who is not in Tasks Users gets
 * an access request and a pending page. Members of Tasks Admins see pending
 * requests and approve them; approval adds the person to Tasks Users in
 * Authentik with a token that can only do that.
 *
 * Admin authorization is checked here, inside each admin operation, against
 * the app admin group (never Home Server Admins, never forward-auth on /admin).
 */
import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db/client.server";
import { ApiError } from "../http/errors.server";
import { getLogger } from "../logging.server";
import {
	AuthentikUnavailable,
	addToUsersGroup,
	findUser,
} from "./authentik.server";
import { getAccessSettings } from "./config.server";
import { currentMembership, saveMemberCheck } from "./membership.server";
import { type AccessRequest, accessRequests } from "./schema.server";
import type { AuthUser } from "./user.server";

const log = getLogger("tasks.access");

export interface RequestDetails {
	sub: string;
	username: string;
	email: string | null;
	name: string | null;
}

/** File (or refresh) a pending request. An approved request is left alone. */
export async function fileAccessRequest(
	db: Db,
	details: RequestDetails,
): Promise<void> {
	await db
		.insert(accessRequests)
		.values({ ...details, status: "pending" })
		.onConflictDoUpdate({
			target: accessRequests.sub,
			set: {
				username: details.username,
				email: details.email,
				name: details.name,
			},
		});
}

export async function getAccessRequest(
	db: Db,
	sub: string,
): Promise<AccessRequest | null> {
	const rows = await db
		.select()
		.from(accessRequests)
		.where(eq(accessRequests.sub, sub))
		.limit(1);
	return rows[0] ?? null;
}

/** Throws 403 unless the caller is a Tasks Admins member right now. */
export async function requireAdmin(db: Db, user: AuthUser): Promise<void> {
	if (user.via === "dev") return;
	if (!user.sub) throw new ApiError(403, "forbidden", "admins only");
	// A fresh answer for an admin action; when Authentik cannot say, the last
	// answer stands, as for every other check.
	const membership = await currentMembership(db, user.sub, user.username, {
		maxAgeMs: 60_000,
	});
	if (!membership.admin) throw new ApiError(403, "forbidden", "admins only");
}

export interface PendingRequestView {
	sub: string;
	username: string;
	email: string | null;
	name: string | null;
	requestedAt: string;
}

export async function listPendingRequests(
	db: Db,
	admin: AuthUser,
): Promise<PendingRequestView[]> {
	await requireAdmin(db, admin);
	const rows = await db
		.select()
		.from(accessRequests)
		.where(eq(accessRequests.status, "pending"))
		.orderBy(asc(accessRequests.requestedAt));
	return rows.map((row) => ({
		sub: row.sub,
		username: row.username,
		email: row.email,
		name: row.name,
		requestedAt: row.requestedAt.toISOString(),
	}));
}

/**
 * Approve a pending request: find the Authentik user (its `uid` must equal
 * the request's `sub`), add them to the users group with the approver token,
 * then record the approval and the new membership.
 */
export async function approveRequest(
	db: Db,
	admin: AuthUser,
	sub: string,
): Promise<void> {
	await requireAdmin(db, admin);
	const request = await getAccessRequest(db, sub);
	if (!request || request.status !== "pending") {
		throw new ApiError(404, "not_found", "no pending request for that person");
	}
	const settings = getAccessSettings();
	try {
		const user = await findUser(settings, request.sub, request.username);
		if (!user || !user.isActive) {
			throw new ApiError(
				409,
				"conflict",
				"that Authentik account no longer exists",
			);
		}
		await addToUsersGroup(settings, user.pk);
		await saveMemberCheck(
			db,
			request.sub,
			request.username,
			{ member: true, admin: user.groups.includes(settings.adminsGroup) },
			"api",
		);
	} catch (err) {
		if (err instanceof AuthentikUnavailable) {
			log.warning("approval failed: Authentik did not answer", {
				sub,
				error: err.message,
			});
			throw new ApiError(
				502,
				"authentik_unavailable",
				"Authentik did not accept the change; try again",
			);
		}
		throw err;
	}
	await db
		.update(accessRequests)
		.set({
			status: "approved",
			decidedBy: admin.username,
			decidedAt: new Date(),
		})
		.where(
			and(eq(accessRequests.sub, sub), eq(accessRequests.status, "pending")),
		);
	log.info("access request approved", {
		sub,
		user: request.username,
		by: admin.username,
	});
}
