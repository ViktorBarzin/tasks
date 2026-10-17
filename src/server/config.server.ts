/**
 * Environment-driven settings (backend/tasks_api/config.py), and the only
 * module that reads process.env. No config files: the Kubernetes stack
 * (infra modules/kubernetes/tanstack_app) injects env and mounts secrets;
 * each secret may be given inline or as a `<NAME>_FILE` path.
 */
import { readFileSync } from "node:fs";
import type { AppAuthConfig, AuthDb } from "@viktorbarzin/auth";
import { parseMetricsPort } from "@viktorbarzin/metrics";
import { type PgSettings, pgSettingsFromEnv } from "@viktorbarzin/pg";

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
	/** TASKS_CALDAV_BASE_URL: the Nextcloud DAV root. */
	caldavBaseUrl: string;
	/** TASKS_LOCAL_TZ. */
	localTimezone: string;
}

/**
 * Read through an alias: Vite rewrites the literal `process.env.NODE_ENV` to
 * "production" at build time, which would make the built server ignore the
 * runtime value. The image sets NODE_ENV=production; HTTP tests against the
 * built server run it with NODE_ENV=test.
 */
const runtimeEnv: Record<string, string | undefined> = process.env;

export function isDevelopment(): boolean {
	return runtimeEnv.NODE_ENV === "development";
}

export function isProduction(): boolean {
	return runtimeEnv.NODE_ENV === "production";
}

function env(name: string): string | null {
	const value = runtimeEnv[name];
	return value === undefined || value.trim() === "" ? null : value.trim();
}

/** `NAME`, or the trimmed contents of the file at `NAME_FILE`. */
function secret(name: string): string | null {
	const inline = env(name);
	if (inline !== null) return inline;
	const path = env(`${name}_FILE`);
	if (path === null) return null;
	const text = readFileSync(path, "utf8").trim();
	return text === "" ? null : text;
}

function list(name: string): string[] {
	return (env(name) ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Read settings fresh from the environment (cheap, and keeps tests simple). */
export function getSettings(): Settings {
	return {
		fernetKey: env("TASKS_FERNET_KEY"),
		caldavBaseUrl: env("TASKS_CALDAV_BASE_URL") ?? DEFAULT_CALDAV_BASE_URL,
		localTimezone: env("TASKS_LOCAL_TZ") ?? DEFAULT_LOCAL_TIMEZONE,
	};
}

export function databaseConfigured(): boolean {
	return env("DATABASE_URL") !== null;
}

/**
 * DATABASE_URL, normally without a password, and DATABASE_PASSWORD_FILE, a
 * mounted file with the Vault-rotated password, read on every new connection.
 */
export function pgSettings(): PgSettings {
	return pgSettingsFromEnv(runtimeEnv);
}

/** METRICS_PORT (9090 in the image), and HOST to bind it to. */
export function metricsListen(): { port: number | null; hostname: string } {
	return {
		port: parseMetricsPort(runtimeEnv.METRICS_PORT),
		hostname: env("HOST") ?? "0.0.0.0",
	};
}

/**
 * The identity config for @viktorbarzin/auth. Cookie names (`__Host-tasks.*`),
 * logger names (`tasks.*`) and the placeholder email domain derive from the
 * slug; the identity metrics keep their `tasks_` prefix.
 */
export function authConfig<TExtra extends object>(
	db: () => AuthDb,
	enrich: AppAuthConfig<TExtra>["enrich"],
): AppAuthConfig<TExtra> {
	const discoveryUrl = env("OIDC_DISCOVERY_URL");
	const clientId = env("OIDC_CLIENT_ID");
	const clientSecret = secret("OIDC_CLIENT_SECRET");
	const audiences = list("API_TOKEN_AUDIENCES");
	return {
		appName: "Tasks",
		appSlug: "tasks",
		db,
		publicOrigins: list("PUBLIC_ORIGINS"),
		betterAuthSecret: secret("BETTER_AUTH_SECRET"),
		oidc:
			discoveryUrl && clientId && clientSecret
				? { discoveryUrl, clientId, clientSecret }
				: null,
		...(audiences.length > 0 ? { apiTokenAudiences: audiences } : {}),
		authentik: {
			apiUrl: env("AUTHENTIK_API_URL"),
			readerToken: secret("AUTHENTIK_READER_TOKEN"),
			approverToken: secret("AUTHENTIK_APPROVER_TOKEN"),
			usersGroupPk: env("AUTHENTIK_USERS_GROUP_ID"),
		},
		// The Terraform module sets AUTH_USERS_GROUP and AUTH_ADMINS_GROUP to
		// these same names; tasks has no agents group in Terraform yet.
		groups: {
			users: env("AUTH_USERS_GROUP") ?? "Tasks Users",
			admins: env("AUTH_ADMINS_GROUP") ?? "Tasks Admins",
			agents: env("AUTH_AGENTS_GROUP") ?? "Tasks Agents",
		},
		guestUsername: env("AUTHENTIK_GUEST_USERNAME") ?? "guest",
		signup: "request",
		// DEV_USER: a dev and test fallback, never in production (and
		// @viktorbarzin/auth ignores it while OIDC is configured).
		devUser: isProduction() ? null : env("DEV_USER"),
		metrics: { prefix: "tasks" },
		...(enrich ? { enrich } : {}),
	};
}
