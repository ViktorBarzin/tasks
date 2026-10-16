/**
 * GET /api/me, POST /api/onboard and the per-request CalDAV engine.
 * Port of backend/tasks_api/routers/me.py, routers/onboard.py and deps.py.
 */
import type { MeResponse, OnboardRequest } from "#/shared/contract";
import type { AuthUser } from "../auth/user.server";
import { CalDAVEngine, type CalDAVTransport } from "../caldav/engine.server";
import { getSettings } from "../config.server";
import {
	accountPassword,
	getAccount,
	upsertAccount,
} from "../db/accounts.server";
import type { Db } from "../db/client.server";
import { ApiError } from "../http/errors.server";
import { getLogger } from "../logging.server";
import type { OpsEngine } from "../ops/ops.server";
import type { SyncEngine } from "../sync/sync.server";

const log = getLogger("tasks.account");

/**
 * Tests replace Nextcloud with the fake CalDAV server here, as the Python
 * app factory's `caldav_transport` argument did. Production leaves it unset.
 */
let transportOverride: CalDAVTransport | undefined;

export function setCalDAVTransportForTests(
	transport: CalDAVTransport | undefined,
): void {
	transportOverride = transport;
}

/** What a request handler needs from the per-user engine. */
export type TasksEngine = OpsEngine &
	SyncEngine &
	Pick<CalDAVEngine, "validateCredentials" | "close">;

export type EngineFactory = (
	ncUsername: string,
	appPassword: string,
) => TasksEngine;

/**
 * Tests of the /api routes swap the whole engine for the engine-level fake
 * Nextcloud (src/test/fake-nextcloud.server.ts). Production leaves it unset.
 */
let engineFactoryOverride: EngineFactory | undefined;

export function setEngineFactoryForTests(
	factory: EngineFactory | undefined,
): void {
	engineFactoryOverride = factory;
}

export function requireFernetKey(): string {
	const { fernetKey } = getSettings();
	if (!fernetKey) {
		throw new ApiError(
			500,
			"server_misconfigured",
			"TASKS_FERNET_KEY is not set",
		);
	}
	return fernetKey;
}

export function buildEngine(
	ncUsername: string,
	appPassword: string,
): TasksEngine {
	if (engineFactoryOverride)
		return engineFactoryOverride(ncUsername, appPassword);
	return new CalDAVEngine({
		baseUrl: getSettings().caldavBaseUrl,
		ncUsername,
		appPassword,
		transport: transportOverride,
	});
}

/** The caller's engine; 409 `not_connected` tells the client to run onboarding. */
export async function engineForUser(
	db: Db,
	user: AuthUser,
): Promise<TasksEngine> {
	const fernetKey = requireFernetKey();
	const account = await getAccount(db, user.accountKey);
	if (!account) {
		throw new ApiError(
			409,
			"not_connected",
			"no Connected Account; onboarding required",
		);
	}
	return buildEngine(account.ncUsername, accountPassword(account, fernetKey));
}

/** GET /api/me: `{"username", "connected"}`. */
export async function getMe(db: Db, user: AuthUser): Promise<MeResponse> {
	const account = await getAccount(db, user.accountKey);
	return { username: user.username, connected: account !== null };
}

/**
 * POST /api/onboard: prove the app password with a live PROPFIND, then
 * encrypt and upsert it. 401 `invalid_credentials` when Nextcloud rejects it.
 */
export async function onboard(
	db: Db,
	user: AuthUser,
	body: OnboardRequest,
): Promise<void> {
	const fernetKey = requireFernetKey();
	const engine = buildEngine(body.nc_username, body.app_password);
	let valid: boolean;
	try {
		valid = await engine.validateCredentials();
	} finally {
		await engine.close();
	}
	if (!valid) {
		throw new ApiError(
			401,
			"invalid_credentials",
			"Nextcloud rejected the app password",
		);
	}
	await upsertAccount(
		db,
		user.accountKey,
		body.nc_username,
		body.app_password,
		fernetKey,
	);
	log.info("connected account onboarded", {
		user: user.accountKey,
		nc_username: body.nc_username,
	});
}
