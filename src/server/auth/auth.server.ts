/**
 * Sign-in, sessions, bearer tokens, membership re-checks, request + approve
 * and the CSRF origin check, from @viktorbarzin/auth (ADR-0001, Identity and
 * access). The app never reads Authentik's forward-auth header
 * `X-Authentik-Username`, and the ingress strips it.
 *
 * tasks adds one thing: `accountKey`, the value its data rows use, found
 * through the identity bridge (identity.server.ts) on every resolved request.
 */
import { type AuthUser, createAppAuth } from "@viktorbarzin/auth";

import { authConfig } from "../config.server";
import { getDb } from "../db/client.server";
import { accountKeyForSubject } from "./identity.server";

export interface TasksExtra {
	/**
	 * The value stored in the `authentik_username` columns of
	 * connected_accounts and applied_ops (identity_links).
	 */
	accountKey: string;
}

export type TasksUser = AuthUser & TasksExtra;

export const appAuth = createAppAuth<TasksExtra>(() =>
	authConfig<TasksExtra>(getDb, async (db, { sub, username }) => ({
		// The dev user has no subject; its rows are keyed by its name.
		accountKey:
			sub === null ? username : await accountKeyForSubject(db, sub, username),
	})),
);
