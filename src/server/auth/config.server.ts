/**
 * Identity settings, read from the environment the Kubernetes stack injects.
 * Secrets arrive through ESO from Vault KV (ADR-0001, Identity and access /
 * Secrets); each secret may be given inline or as a `*_FILE` path.
 */
import { readFileSync } from "node:fs";

const runtimeEnv: Record<string, string | undefined> = process.env;

function env(name: string): string | null {
	const value = runtimeEnv[name];
	return value === undefined || value.trim() === "" ? null : value.trim();
}

/** `NAME`, or the trimmed contents of the file at `NAME_FILE`. */
export function secret(name: string): string | null {
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

/** PUBLIC_ORIGINS: comma-separated exact origins, e.g. "https://tasks.viktorbarzin.me". */
export function publicOrigins(): string[] {
	return list("PUBLIC_ORIGINS").map((origin) => new URL(origin).origin);
}

export interface OidcSettings {
	/** OIDC_DISCOVERY_URL: the provider's `.well-known/openid-configuration`. */
	discoveryUrl: string;
	/** OIDC_CLIENT_ID: the web client (confidential). */
	clientId: string;
	/** OIDC_CLIENT_SECRET (or _FILE). */
	clientSecret: string;
}

export interface AuthSettings {
	/** The first PUBLIC_ORIGINS entry: Better Auth's baseURL and the OAuth redirect host. */
	baseUrl: string;
	/** Every PUBLIC_ORIGINS entry: Better Auth trustedOrigins and the CSRF allow-list. */
	origins: string[];
	/** BETTER_AUTH_SECRET (or _FILE): signs session cookies and OAuth state. */
	secret: string;
	oidc: OidcSettings;
}

/** Null when sign-in is not configured (dev and tests that use DEV_USER). */
export function getAuthSettings(): AuthSettings | null {
	const discoveryUrl = env("OIDC_DISCOVERY_URL");
	const clientId = env("OIDC_CLIENT_ID");
	const clientSecret = secret("OIDC_CLIENT_SECRET");
	const authSecret = secret("BETTER_AUTH_SECRET");
	const origins = publicOrigins();
	if (!discoveryUrl || !clientId || !clientSecret || !authSecret) return null;
	if (origins.length === 0) {
		throw new Error("PUBLIC_ORIGINS must be set when OIDC sign-in is enabled");
	}
	return {
		baseUrl: origins[0] as string,
		origins,
		secret: authSecret,
		oidc: { discoveryUrl, clientId, clientSecret },
	};
}

export interface TokenSettings {
	/** OIDC_DISCOVERY_URL: where the issuer and jwks_uri are read from. */
	discoveryUrl: string;
	/**
	 * API_TOKEN_AUDIENCES: the app's client IDs (web client, CLI device-code
	 * client); Authentik sets `aud` to the client_id. Defaults to OIDC_CLIENT_ID.
	 */
	audiences: string[];
}

export function getTokenSettings(): TokenSettings | null {
	const discoveryUrl = env("OIDC_DISCOVERY_URL");
	if (!discoveryUrl) return null;
	const audiences = list("API_TOKEN_AUDIENCES");
	const clientId = env("OIDC_CLIENT_ID");
	if (audiences.length === 0 && clientId) audiences.push(clientId);
	if (audiences.length === 0) return null;
	return { discoveryUrl, audiences };
}

export interface AccessSettings {
	/** AUTHENTIK_API_URL, e.g. https://authentik.viktorbarzin.me. */
	apiUrl: string | null;
	/**
	 * AUTHENTIK_READER_TOKEN (or _FILE): a service account that may view users
	 * and groups. Used for membership re-checks and to find a user's pk.
	 */
	readerToken: string | null;
	/**
	 * AUTHENTIK_APPROVER_TOKEN (or _FILE): a token that may only add users to
	 * the app's users group. Used when an admin approves a request.
	 */
	approverToken: string | null;
	/**
	 * AUTHENTIK_USERS_GROUP_ID: the users group's UUID (pk); looked up by name
	 * when unset. infra stacks/tasks sets it in Secret tasks-authentik-approver.
	 */
	usersGroupPk: string | null;
	/** TASKS_USERS_GROUP, default "Tasks Users". */
	usersGroup: string;
	/** TASKS_ADMINS_GROUP, default "Tasks Admins". Admins are members too. */
	adminsGroup: string;
	/** TASKS_AGENTS_GROUP, default "Tasks Agents": service accounts for agents and Home Assistant. */
	agentsGroup: string;
	/** AUTHENTIK_GUEST_USERNAME, default "guest": the anonymous auto-login identity. */
	guestUsername: string;
}

export function getAccessSettings(): AccessSettings {
	return {
		apiUrl: env("AUTHENTIK_API_URL")?.replace(/\/+$/, "") ?? null,
		readerToken: secret("AUTHENTIK_READER_TOKEN"),
		approverToken: secret("AUTHENTIK_APPROVER_TOKEN"),
		usersGroupPk: env("AUTHENTIK_USERS_GROUP_ID"),
		usersGroup: env("TASKS_USERS_GROUP") ?? "Tasks Users",
		adminsGroup: env("TASKS_ADMINS_GROUP") ?? "Tasks Admins",
		agentsGroup: env("TASKS_AGENTS_GROUP") ?? "Tasks Agents",
		guestUsername: env("AUTHENTIK_GUEST_USERNAME") ?? "guest",
	};
}
