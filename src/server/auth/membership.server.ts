/**
 * Membership: may this subject use the app, and administer it?
 *
 * ADR-0001 (Identity and access / Sessions): each refresh re-checks group
 * membership with Authentik, so removing someone takes effect within 15
 * minutes. Web sign-in requests no `offline_access`, so Authentik issues no
 * refresh token; the app's "refresh" is this re-check. An answer older than
 * MEMBERSHIP_MAX_AGE_MS is re-asked through the reader token before the
 * request proceeds.
 *
 * The first answer comes from the verified id_token's `groups` claim at
 * sign-in (or a bearer token's), so a fresh sign-in needs no API call.
 *
 * Failure direction: when Authentik cannot give an answer (a network error,
 * any status but 200), the last answer stands, as in f1-stream's membership
 * check. Only an answer Authentik actually gave can remove access. With no
 * earlier answer at all the subject is not a member.
 *
 * A missing AUTHENTIK_API_URL or reader token is different: the app could
 * never re-check, so keeping the last answer would let a removed person keep
 * access for the whole 7-day session. That case fails closed (not a member)
 * and logs an ERROR on every re-check until the configuration is fixed.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.server";
import { getLogger } from "../logging.server";
import { membershipChecksTotal } from "./auth-metrics.server";
import {
	AuthentikNotConfigured,
	AuthentikUnavailable,
	findUser,
} from "./authentik.server";
import { type AccessSettings, getAccessSettings } from "./config.server";
import { type MemberCheck, memberChecks } from "./schema.server";

const log = getLogger("tasks.membership");

/** ADR-0001: access tokens are valid for 15 minutes at most. */
export const MEMBERSHIP_MAX_AGE_MS = 15 * 60 * 1000;

export interface Membership {
	member: boolean;
	admin: boolean;
}

/** Members are in the users, admins or agents group; admins are in the admins group. */
export function membershipFromGroups(
	groups: readonly string[],
	settings: AccessSettings = getAccessSettings(),
): Membership {
	const set = new Set(groups);
	const admin = set.has(settings.adminsGroup);
	return {
		member:
			admin || set.has(settings.usersGroup) || set.has(settings.agentsGroup),
		admin,
	};
}

export async function readMemberCheck(
	db: Db,
	sub: string,
): Promise<MemberCheck | null> {
	const rows = await db
		.select()
		.from(memberChecks)
		.where(eq(memberChecks.sub, sub))
		.limit(1);
	return rows[0] ?? null;
}

export async function saveMemberCheck(
	db: Db,
	sub: string,
	username: string,
	membership: Membership,
	source: "id_token" | "token" | "api",
	checkedAt: Date = new Date(),
): Promise<void> {
	const row = { sub, username, ...membership, source, checkedAt };
	await db
		.insert(memberChecks)
		.values(row)
		.onConflictDoUpdate({
			target: memberChecks.sub,
			set: { username, ...membership, source, checkedAt },
		});
}

/**
 * Record an answer that came with a verified token (`groups` claim). A token
 * without the claim says nothing about membership and changes nothing.
 */
export async function recordClaimedGroups(
	db: Db,
	sub: string,
	username: string,
	groups: unknown,
	source: "id_token" | "token",
): Promise<void> {
	if (!Array.isArray(groups)) return;
	const names = groups.filter((g): g is string => typeof g === "string");
	await saveMemberCheck(db, sub, username, membershipFromGroups(names), source);
}

/** Ask Authentik now. Throws AuthentikUnavailable when it cannot say. */
async function askAuthentik(
	sub: string,
	username: string,
): Promise<Membership> {
	const settings = getAccessSettings();
	const user = await findUser(settings, sub, username);
	if (!user || !user.isActive) return { member: false, admin: false };
	return membershipFromGroups(user.groups, settings);
}

const inFlight = new Map<string, Promise<Membership>>();

async function recheck(
	db: Db,
	sub: string,
	username: string,
	last: MemberCheck | null,
): Promise<Membership> {
	try {
		const answer = await askAuthentik(sub, username);
		membershipChecksTotal.inc({
			outcome: answer.member ? "member" : "removed",
		});
		if (last?.member && !answer.member) {
			log.info("membership: no longer a member", { sub, user: username });
		}
		await saveMemberCheck(db, sub, username, answer, "api");
		return answer;
	} catch (err) {
		if (err instanceof AuthentikNotConfigured) {
			membershipChecksTotal.inc({ outcome: "misconfigured" });
			log.error("membership: cannot re-check, access refused", {
				sub,
				user: username,
				error: err.message,
			});
			return { member: false, admin: false };
		}
		if (!(err instanceof AuthentikUnavailable)) throw err;
		membershipChecksTotal.inc({ outcome: "unreachable" });
		log.warning("membership: cannot check, the last answer stands", {
			sub,
			user: username,
			error: err.message,
		});
		return last
			? { member: last.member, admin: last.admin }
			: { member: false, admin: false };
	}
}

export interface MembershipOptions {
	/** Re-ask when the stored answer is older than this. 0 forces a fresh answer. */
	maxAgeMs?: number;
	now?: () => number;
}

/**
 * The subject's membership, re-asked from Authentik when the stored answer is
 * older than `maxAgeMs` (default 15 minutes). Concurrent re-checks for one
 * subject share a single API call.
 */
export async function currentMembership(
	db: Db,
	sub: string,
	username: string,
	options: MembershipOptions = {},
): Promise<Membership> {
	const maxAge = options.maxAgeMs ?? MEMBERSHIP_MAX_AGE_MS;
	const now = options.now ?? Date.now;
	const last = await readMemberCheck(db, sub);
	if (last && maxAge > 0 && now() - last.checkedAt.getTime() < maxAge) {
		return { member: last.member, admin: last.admin };
	}
	const pending = inFlight.get(sub);
	if (pending) return pending;
	const started = recheck(db, sub, username, last).finally(() =>
		inFlight.delete(sub),
	);
	inFlight.set(sub, started);
	return started;
}
