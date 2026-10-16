/**
 * Environment-driven settings (backend/tasks_api/config.py). No config files:
 * the Kubernetes stack injects env and mounts secrets.
 */

export const DEFAULT_CALDAV_BASE_URL =
	"https://nextcloud.viktorbarzin.me/remote.php/dav";
/**
 * Household wall-clock zone for all-day recurrence roll-forward
 * (contract delta v1.1 §F). Overridable with TASKS_LOCAL_TZ.
 */
export const DEFAULT_LOCAL_TIMEZONE = "Europe/Sofia";

export interface Settings {
	/** TASKS_FERNET_KEY: encrypts Connected Account app passwords (tasks ADR-0002). */
	fernetKey: string | null;
	/** DEV_USER: dev/test identity fallback. Ignored when NODE_ENV is "production". */
	devUser: string | null;
	/** TASKS_CALDAV_BASE_URL: the Nextcloud DAV root. */
	caldavBaseUrl: string;
	/** TASKS_LOCAL_TZ. */
	localTimezone: string;
	/** LOG_LEVEL: DEBUG | INFO | WARNING | ERROR. */
	logLevel: string;
}

export interface DatabaseSettings {
	/**
	 * DATABASE_URL, normally without a password, e.g.
	 * `postgres://tasks@pg-cluster-rw.dbaas:5432/tasks`.
	 */
	url: string;
	/**
	 * DATABASE_PASSWORD_FILE: a mounted file holding the Vault-rotated password.
	 * Read on every new connection, so rotation does not break new connections.
	 * When unset, the password inside DATABASE_URL is used (local dev, tests).
	 */
	passwordFile: string | null;
}

/**
 * Read through an alias: Vite rewrites the literal `process.env.NODE_ENV` to
 * "production" at build time, which would make the built server ignore the
 * runtime value. The image sets NODE_ENV=production; HTTP tests against the
 * built server run it with NODE_ENV=test.
 */
const runtimeEnv: Record<string, string | undefined> = process.env;

export function isProduction(): boolean {
	return runtimeEnv.NODE_ENV === "production";
}

function env(name: string): string | null {
	const value = runtimeEnv[name];
	return value === undefined || value === "" ? null : value;
}

/** Read settings fresh from the environment (cheap, and keeps tests simple). */
export function getSettings(): Settings {
	return {
		fernetKey: env("TASKS_FERNET_KEY"),
		devUser: isProduction() ? null : env("DEV_USER"),
		caldavBaseUrl: env("TASKS_CALDAV_BASE_URL") ?? DEFAULT_CALDAV_BASE_URL,
		localTimezone: env("TASKS_LOCAL_TZ") ?? DEFAULT_LOCAL_TIMEZONE,
		logLevel: env("LOG_LEVEL") ?? "INFO",
	};
}

export function getDatabaseSettings(): DatabaseSettings {
	const url = env("DATABASE_URL");
	if (url === null) {
		throw new Error("DATABASE_URL is not set");
	}
	return { url, passwordFile: env("DATABASE_PASSWORD_FILE") };
}
