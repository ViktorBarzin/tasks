/**
 * Server functions for the pending and approval pages (internal RPC for this
 * app's own UI; CLIs use /api server routes). Safe to import from components:
 * Start replaces each handler with an RPC stub in the client bundle, and the
 * server-only imports below are only used inside handlers.
 *
 * Admin authorization is checked inside each admin function (ADR-0001,
 * Identity and access / Admin).
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { getDb } from "../db/client.server";
import { ApiError } from "../http/errors.server";
import {
	approveRequest,
	getAccessRequest,
	listPendingRequests,
	type PendingRequestView,
} from "./access.server";
import { currentMembership } from "./membership.server";
import { resolveUser } from "./user.server";

export interface AccessStatus {
	signedIn: boolean;
	username: string | null;
	member: boolean;
	admin: boolean;
	/** Set while an access request is waiting. */
	requestedAt: string | null;
}

async function statusFor(recheck: boolean): Promise<AccessStatus> {
	const request = getRequest();
	let user = await resolveUser(request);
	if (!user) {
		return {
			signedIn: false,
			username: null,
			member: false,
			admin: false,
			requestedAt: null,
		};
	}
	const db = getDb();
	if (recheck && user.sub) {
		const membership = await currentMembership(db, user.sub, user.username, {
			maxAgeMs: 0,
		});
		user = { ...user, ...membership };
	}
	const pending =
		user.sub && !user.member ? await getAccessRequest(db, user.sub) : null;
	return {
		signedIn: true,
		username: user.username,
		member: user.member,
		admin: user.admin,
		requestedAt:
			pending?.status === "pending" ? pending.requestedAt.toISOString() : null,
	};
}

/** Who is signed in and whether they may use the app yet. */
export const getAccessStatus = createServerFn({ method: "GET" }).handler(() =>
	statusFor(false),
);

/** Ask Authentik again now (the pending page's "Check again"). */
export const recheckAccess = createServerFn({ method: "POST" }).handler(() =>
	statusFor(true),
);

async function requireSignedIn() {
	const user = await resolveUser(getRequest());
	if (!user) throw new ApiError(401, "unauthorized", "not signed in");
	return user;
}

/** Pending access requests, oldest first. Tasks Admins only. */
export const listAccessRequests = createServerFn({ method: "GET" }).handler(
	async (): Promise<PendingRequestView[]> => {
		const user = await requireSignedIn();
		return listPendingRequests(getDb(), user);
	},
);

/** Approve one request: adds the person to Tasks Users in Authentik. Tasks Admins only. */
export const approveAccessRequest = createServerFn({ method: "POST" })
	.validator(z.object({ sub: z.string().min(1).max(255) }))
	.handler(async ({ data }) => {
		const user = await requireSignedIn();
		await approveRequest(getDb(), user, data.sub);
		return { ok: true as const };
	});
