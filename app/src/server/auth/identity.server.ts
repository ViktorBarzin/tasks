/**
 * The identity bridge (ADR-0001, Pilot / Identity). Users are keyed on the
 * OIDC `sub`; the rows the Python app wrote are keyed on the Authentik
 * username from the forward-auth header. A subject's first sign-in maps it to
 * the row key through `preferred_username`, once, and the mapping is kept in
 * identity_links. Existing primary keys are never rewritten.
 *
 * When the username is already linked to a different subject (the account was
 * deleted and the name reused), the newcomer does not inherit that data: they
 * get a key of their own, `sub:<sub>`.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.server";
import { getLogger } from "../logging.server";
import { identityLinks } from "./schema.server";

const log = getLogger("tasks.identity");

/** The prefix of keys minted for a subject whose username was taken. */
export const OWN_KEY_PREFIX = "sub:";

async function linkedKey(db: Db, sub: string): Promise<string | null> {
	const rows = await db
		.select({ accountKey: identityLinks.accountKey })
		.from(identityLinks)
		.where(eq(identityLinks.sub, sub))
		.limit(1);
	return rows[0]?.accountKey ?? null;
}

async function tryLink(
	db: Db,
	sub: string,
	accountKey: string,
	username: string,
): Promise<boolean> {
	const inserted = await db
		.insert(identityLinks)
		.values({ sub, accountKey, linkedUsername: username })
		.onConflictDoNothing()
		.returning({ sub: identityLinks.sub });
	return inserted.length > 0;
}

/**
 * The account key for `sub`, creating the link on first use. Safe under
 * concurrency: two first requests for one subject end on the same key.
 */
export async function accountKeyForSubject(
	db: Db,
	sub: string,
	preferredUsername: string,
): Promise<string> {
	const existing = await linkedKey(db, sub);
	if (existing !== null) return existing;

	if (
		preferredUsername &&
		(await tryLink(db, sub, preferredUsername, preferredUsername))
	) {
		log.info("linked subject to its username", {
			sub,
			user: preferredUsername,
		});
		return preferredUsername;
	}
	// Either another request linked this subject first, or the username
	// belongs to a different subject.
	const raced = await linkedKey(db, sub);
	if (raced !== null) return raced;

	const own = `${OWN_KEY_PREFIX}${sub}`;
	log.warning(
		"username already linked to a different subject; using a key of its own",
		{
			sub,
			user: preferredUsername,
		},
	);
	await tryLink(db, sub, own, preferredUsername);
	return (await linkedKey(db, sub)) ?? own;
}
