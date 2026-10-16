/**
 * Connected Accounts: the credential store behind onboarding
 * (backend/tasks_api/accounts.py, tasks ADR-0002). Storage only; the live
 * CalDAV check lives in CalDAVEngine.validateCredentials.
 */
import { eq } from "drizzle-orm";

import {
	decryptAppPassword,
	encryptAppPassword,
} from "../crypto/fernet.server";
import type { Db } from "./client.server";
import { type ConnectedAccount, connectedAccounts } from "./schema.server";

export async function getAccount(
	db: Db,
	accountKey: string,
): Promise<ConnectedAccount | null> {
	const rows = await db
		.select()
		.from(connectedAccounts)
		.where(eq(connectedAccounts.authentikUsername, accountKey))
		.limit(1);
	return rows[0] ?? null;
}

/** Create or refresh the Connected Account (re-onboarding rotates in place). */
export async function upsertAccount(
	db: Db,
	accountKey: string,
	ncUsername: string,
	appPassword: string,
	fernetKey: string,
): Promise<ConnectedAccount> {
	const encAppPassword = encryptAppPassword(appPassword, fernetKey);
	const [row] = await db
		.insert(connectedAccounts)
		.values({ authentikUsername: accountKey, ncUsername, encAppPassword })
		.onConflictDoUpdate({
			target: connectedAccounts.authentikUsername,
			set: { ncUsername, encAppPassword, updatedAt: new Date() },
		})
		.returning();
	if (!row) throw new Error("upsert returned no row");
	return row;
}

/** Decrypt the stored app password for CalDAV use. */
export function accountPassword(
	account: ConnectedAccount,
	fernetKey: string,
): string {
	return decryptAppPassword(account.encAppPassword, fernetKey);
}
