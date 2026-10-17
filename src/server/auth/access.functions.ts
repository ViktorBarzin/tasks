/**
 * Server functions for the pending and approval pages (internal RPC for this
 * app's own UI; CLIs use /api server routes). Safe to import from components:
 * Start replaces each handler with an RPC stub in the client bundle, and the
 * server-only imports below are only used inside handlers.
 *
 * Admin authorization is checked inside each admin operation
 * (@viktorbarzin/auth), never by the page or the ingress.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { AccessStatus, PendingRequestView } from "@viktorbarzin/auth";
import { ApiError } from "@viktorbarzin/runtime";
import { z } from "zod";

import { appAuth } from "./auth.server";

export type { AccessStatus, PendingRequestView };

/** Who is signed in and whether they may use the app yet. */
export const getAccessStatus = createServerFn({ method: "GET" }).handler(
	(): Promise<AccessStatus> => appAuth.accessStatus(getRequest()),
);

/** Ask Authentik again now (the pending page's "Check again"). */
export const recheckAccess = createServerFn({ method: "POST" }).handler(
	(): Promise<AccessStatus> =>
		appAuth.accessStatus(getRequest(), { recheck: true }),
);

async function requireSignedIn() {
	const user = await appAuth.resolveUser(getRequest());
	if (!user) throw new ApiError(401, "unauthorized", "not signed in");
	return user;
}

/** Pending access requests, oldest first. Tasks Admins only. */
export const listAccessRequests = createServerFn({ method: "GET" }).handler(
	async (): Promise<PendingRequestView[]> =>
		appAuth.listPendingRequests(await requireSignedIn()),
);

/** Approve one request: adds the person to Tasks Users in Authentik. Tasks Admins only. */
export const approveAccessRequest = createServerFn({ method: "POST" })
	.validator(z.object({ sub: z.string().min(1).max(255) }))
	.handler(async ({ data }) => {
		await appAuth.approveRequest(await requireSignedIn(), data.sub);
		return { ok: true as const };
	});
