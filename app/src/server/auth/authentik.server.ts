/**
 * The few Authentik API calls the app makes (base `${AUTHENTIK_API_URL}/api/v3`):
 *
 * - find a user and their groups (reader token):
 *   `GET /core/users/?username=<u>&include_groups=true`
 * - find a group's pk by name (reader token), when AUTHENTIK_USERS_GROUP_ID is unset:
 *   `GET /core/groups/?name=<n>`
 * - add a user to the users group (approver token):
 *   `POST /core/groups/<group_pk>/add_user/` with `{"pk": <user_pk>}`, answered 204
 *
 * Users are keyed on `sub` and never authorized by name: a username lookup
 * only counts when the user's `uid` equals the `sub` the app holds
 * (sub_mode hashed_user_id makes `sub` the user's `uid`).
 */
import { getLogger } from "../logging.server";
import type { AccessSettings } from "./config.server";

const log = getLogger("tasks.authentik");

/** Authentik is on the request path of a membership re-check: keep it short. */
export const AUTHENTIK_TIMEOUT_MS = 5_000;

/** Authentik did not give an answer this module can believe. */
export class AuthentikUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthentikUnavailable";
	}
}

/**
 * The app cannot ask Authentik at all: AUTHENTIK_API_URL or the token is not
 * set. A configuration error, not an outage, so callers that keep the last
 * answer through an outage must not keep it through this.
 */
export class AuthentikNotConfigured extends AuthentikUnavailable {
	constructor(message: string) {
		super(message);
		this.name = "AuthentikNotConfigured";
	}
}

export interface AuthentikUser {
	pk: number;
	uid: string;
	username: string;
	isActive: boolean;
	groups: string[];
}

async function call(
	settings: AccessSettings,
	token: string | null,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	if (!settings.apiUrl)
		throw new AuthentikNotConfigured("AUTHENTIK_API_URL is not set");
	if (!token)
		throw new AuthentikNotConfigured("no Authentik API token configured");
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${token}`);
	headers.set("accept", "application/json");
	try {
		return await fetch(`${settings.apiUrl}/api/v3${path}`, {
			...init,
			headers,
			signal: AbortSignal.timeout(AUTHENTIK_TIMEOUT_MS),
		});
	} catch (err) {
		throw new AuthentikUnavailable(`unreachable: ${String(err)}`);
	}
}

async function readResults(
	response: Response,
	what: string,
): Promise<unknown[]> {
	// Any status but 200 is "cannot say": a token missing a permission answers
	// 403, and reading that as "not a member" would lock people out.
	if (response.status !== 200) {
		throw new AuthentikUnavailable(`${what} answered ${response.status}`);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new AuthentikUnavailable(`${what} did not answer JSON`);
	}
	const results = (body as { results?: unknown })?.results;
	if (!Array.isArray(results)) {
		throw new AuthentikUnavailable(
			`${what} answered something other than a list`,
		);
	}
	return results;
}

/**
 * The Authentik user whose `uid` is `sub`, found by `username`; null when
 * Authentik answered and no such user exists (deleted, or the name now
 * belongs to someone else). Throws AuthentikUnavailable otherwise.
 */
export async function findUser(
	settings: AccessSettings,
	sub: string,
	username: string,
): Promise<AuthentikUser | null> {
	const query = new URLSearchParams({ username, include_groups: "true" });
	const response = await call(
		settings,
		settings.readerToken,
		`/core/users/?${query}`,
	);
	for (const raw of await readResults(response, "user lookup")) {
		const found = raw as Record<string, unknown>;
		if (found.username !== username || found.uid !== sub) continue;
		if (typeof found.pk !== "number") continue;
		const groups = Array.isArray(found.groups_obj)
			? found.groups_obj
					.map((group) => (group as { name?: unknown })?.name)
					.filter((name): name is string => typeof name === "string")
			: [];
		return {
			pk: found.pk,
			uid: sub,
			username,
			isActive: found.is_active === true,
			groups,
		};
	}
	return null;
}

/** The users group's pk: AUTHENTIK_USERS_GROUP_ID, or a lookup by name. */
export async function usersGroupPk(settings: AccessSettings): Promise<string> {
	if (settings.usersGroupPk) return settings.usersGroupPk;
	const query = new URLSearchParams({ name: settings.usersGroup });
	const response = await call(
		settings,
		settings.readerToken,
		`/core/groups/?${query}`,
	);
	for (const raw of await readResults(response, "group lookup")) {
		const group = raw as { name?: unknown; pk?: unknown };
		if (group.name === settings.usersGroup && typeof group.pk === "string") {
			return group.pk;
		}
	}
	throw new AuthentikUnavailable(
		`group "${settings.usersGroup}" was not found`,
	);
}

/** Add a user to the users group with the approver token. */
export async function addToUsersGroup(
	settings: AccessSettings,
	userPk: number,
): Promise<void> {
	const groupPk = await usersGroupPk(settings);
	const response = await call(
		settings,
		settings.approverToken,
		`/core/groups/${encodeURIComponent(groupPk)}/add_user/`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pk: userPk }),
		},
	);
	if (response.status !== 204 && response.status !== 200) {
		log.warning("adding a user to the users group failed", {
			status: response.status,
			group: settings.usersGroup,
		});
		throw new AuthentikUnavailable(`add_user answered ${response.status}`);
	}
}
