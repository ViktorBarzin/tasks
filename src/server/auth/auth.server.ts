/**
 * The Better Auth instance (ADR-0001, Identity and access / Sessions):
 * generic OAuth against Authentik with PKCE and a verified id_token, the
 * Drizzle adapter (sessions in this app's database), host-only `__Host-`
 * cookies, exact trustedOrigins, sessions capped at 7 days and never
 * extended, and no `offline_access`.
 *
 * Sign-in goes through /api/auth/start and /api/auth/finish
 * (session.server.ts), not Better Auth's own /sign-in/social over HTTP.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, getOAuthState } from "better-auth/api";
import {
	type GenericOAuthUserInfo,
	genericOAuth,
} from "better-auth/plugins/generic-oauth";

import { getDb } from "../db/client.server";
import { getLogger } from "../logging.server";
import { fileAccessRequest } from "./access.server";
import { signInsTotal } from "./auth-metrics.server";
import {
	type AuthSettings,
	getAccessSettings,
	getAuthSettings,
} from "./config.server";
import { accountKeyForSubject } from "./identity.server";
import { currentMembership, recordClaimedGroups } from "./membership.server";
import { betterAuthSchema } from "./schema.server";

const log = getLogger("tasks.auth");

export const PROVIDER_ID = "authentik";
export const AUTH_BASE_PATH = "/api/auth";
export const START_PATH = `${AUTH_BASE_PATH}/start`;
export const FINISH_PATH = `${AUTH_BASE_PATH}/finish`;
export const ERROR_PATH = `${AUTH_BASE_PATH}/error`;
/** Marks a sign-in that already asked Authentik for `prompt=login`. */
export const LOGIN_PARAM = "login";

/** ADR-0001: sessions have an absolute cap of 7 days. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** `__Host-` needs Secure, Path=/ and no Domain; Better Auth adds its own `__Secure-` otherwise. */
export const COOKIE_PREFIX = "__Host-tasks";

/** Set by the ingress's real-ip plugin (infra stacks/traefik, `rate-limit` chain). */
export const CLIENT_IP_HEADER = "x-real-ip";

/** Better Auth endpoints this app does not use; refused over HTTP (404). */
export const DISABLED_PATHS = [
	"/sign-in/social",
	"/sign-in/oauth2",
	"/sign-in/email",
	"/sign-up/email",
	"/update-user",
	"/delete-user",
	"/change-email",
	"/change-password",
	"/set-password",
	"/request-password-reset",
	"/reset-password",
	"/link-social",
	"/unlink-account",
	"/list-accounts",
	"/account-info",
	"/get-access-token",
	"/refresh-token",
	"/update-session",
];

/** True for a value a browser would resolve against another host. */
function leavesOrigin(path: string): boolean {
	return path.startsWith("//") || path.startsWith("/\\");
}

/**
 * A relative path inside this app to return to after sign-in, or "/".
 * Refuses absolute and protocol-relative URLs (no open redirect). The check
 * runs on the normalised result too: dot segments collapse, so `/.//evil`
 * normalises to `//evil`.
 */
export function safeReturnPath(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith("/") || leavesOrigin(raw)) return "/";
	try {
		const url = new URL(raw, "http://app.invalid");
		if (url.origin !== "http://app.invalid") return "/";
		const path = `${url.pathname}${url.search}`;
		return leavesOrigin(path) ? "/" : path;
	} catch {
		return "/";
	}
}

export function finishUrl(returnTo: string, afterLogin: boolean): string {
	const query = new URLSearchParams({ return: safeReturnPath(returnTo) });
	if (afterLogin) query.set(LOGIN_PARAM, "1");
	return `${FINISH_PATH}?${query}`;
}

export function startUrl(returnTo: string, forceLogin: boolean): string {
	const query = new URLSearchParams({ return: safeReturnPath(returnTo) });
	if (forceLogin) query.set(LOGIN_PARAM, "1");
	return `${START_PATH}?${query}`;
}

/**
 * The anonymous `guest` came back from Authentik (a public host signed the
 * browser in as guest). Restart the sign-in with `prompt=login`; if that
 * already happened, stop on the error page instead of looping.
 */
async function redirectGuest(): Promise<never> {
	signInsTotal.inc({ outcome: "guest" });
	const state = await getOAuthState().catch(() => null);
	const callback = new URL(
		state?.callbackURL ?? FINISH_PATH,
		"http://app.invalid",
	);
	const returnTo = callback.searchParams.get("return") ?? "/";
	const location = callback.searchParams.has(LOGIN_PARAM)
		? `${ERROR_PATH}?error=guest_session`
		: startUrl(returnTo, true);
	log.info("guest session at the identity provider; asking for a real login", {
		retried: callback.searchParams.has(LOGIN_PARAM),
	});
	throw new APIError("FOUND", undefined, { location });
}

/**
 * Runs on every sign-in, after Better Auth verified the id_token (issuer,
 * audience, signature, nonce). Records the membership answer the token
 * carries, the identity link and, for a non-member, an access request.
 */
async function onVerifiedProfile(profile: GenericOAuthUserInfo) {
	const sub =
		typeof profile.sub === "string" ? profile.sub : String(profile.sub ?? "");
	const username =
		typeof profile.preferred_username === "string"
			? profile.preferred_username
			: "";
	if (!sub || !username) {
		throw new APIError("UNAUTHORIZED", {
			message: "the identity provider sent no sub or username",
		});
	}
	if (username === getAccessSettings().guestUsername) await redirectGuest();

	const email =
		typeof profile.email === "string" && profile.email !== ""
			? profile.email
			: null;
	const name =
		typeof profile.name === "string" && profile.name !== ""
			? profile.name
			: username;
	const db = getDb();
	await recordClaimedGroups(db, sub, username, profile.groups, "id_token");
	await accountKeyForSubject(db, sub, username);
	const membership = await currentMembership(db, sub, username);
	if (!membership.member)
		await fileAccessRequest(db, { sub, username, email, name });
	signInsTotal.inc({ outcome: membership.member ? "member" : "pending" });
	log.info("signed in", { sub, user: username, member: membership.member });
	return {
		name,
		// Better Auth needs an email; it is never used to authorize (users are keyed on sub).
		email: email ?? `${sub}@users.tasks.invalid`,
		emailVerified: profile.email_verified === true,
		image: undefined,
	};
}

function createAuth(settings: AuthSettings) {
	return betterAuth({
		appName: "Tasks",
		baseURL: settings.baseUrl,
		basePath: AUTH_BASE_PATH,
		secret: settings.secret,
		trustedOrigins: settings.origins,
		database: drizzleAdapter(getDb(), {
			provider: "pg",
			schema: betterAuthSchema,
		}),
		user: { modelName: "auth_user" },
		session: {
			modelName: "auth_session",
			expiresIn: SESSION_MAX_AGE_SECONDS,
			// An absolute cap: the expiry is never pushed out.
			disableSessionRefresh: true,
			cookieCache: { enabled: false },
		},
		account: {
			modelName: "auth_account",
			// Never link accounts by email: users are keyed on sub.
			accountLinking: { enabled: false },
			encryptOAuthTokens: true,
		},
		verification: { modelName: "auth_verification" },
		emailAndPassword: { enabled: false },
		disabledPaths: DISABLED_PATHS,
		telemetry: { enabled: false },
		advanced: {
			// The rate limiter (on in production) keys on the client IP. Behind
			// Cloudflare and Traefik, X-Forwarded-For carries several hops, which
			// Better Auth refuses without trustedProxies and then puts every client
			// in one shared bucket. The ingress's default `rate-limit` chain runs the
			// real-ip plugin first, which overwrites X-Real-Ip with the client
			// address from the TCP peer, so a client cannot spoof it.
			ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
			cookiePrefix: COOKIE_PREFIX,
			useSecureCookies: false,
			defaultCookieAttributes: {
				secure: true,
				sameSite: "lax",
				path: "/",
				httpOnly: true,
			},
		},
		plugins: [
			genericOAuth({
				config: [
					{
						providerId: PROVIDER_ID,
						name: "Authentik",
						discoveryUrl: settings.oidc.discoveryUrl,
						requireIdTokenVerification: true,
						clientId: settings.oidc.clientId,
						clientSecret: settings.oidc.clientSecret,
						// No offline_access: web sign-in gets no refresh token (ADR-0001, Secrets).
						scopes: ["openid", "profile", "email"],
						pkce: true,
						disableProviderLogout: true,
						overrideUserInfo: true,
						mapProfileToUser: onVerifiedProfile,
					},
				],
			}),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;

let instance: { auth: Auth; key: string } | null = null;
let lastRebuild = 0;
/** How often a missing provider (discovery failed at init) may trigger a rebuild. */
const REBUILD_INTERVAL_MS = 10_000;

/** The Better Auth instance, or null when sign-in is not configured. */
export function getAuth(): Auth | null {
	const settings = getAuthSettings();
	if (!settings) return null;
	const key = JSON.stringify(settings);
	if (instance?.key !== key) instance = { auth: createAuth(settings), key };
	return instance.auth;
}

/**
 * The instance with the Authentik provider registered. Better Auth skips a
 * provider whose discovery fetch failed at init; rebuild (at most every 10 s)
 * so an Authentik blip at pod start does not disable sign-in until restart.
 */
export async function getAuthWithProvider(): Promise<Auth | null> {
	const auth = getAuth();
	if (!auth) return null;
	const context = await auth.$context;
	if (context.socialProviders.some((provider) => provider.id === PROVIDER_ID))
		return auth;
	const now = Date.now();
	if (now - lastRebuild >= REBUILD_INTERVAL_MS) {
		lastRebuild = now;
		instance = null;
		const rebuilt = getAuth();
		if (rebuilt) {
			const again = await rebuilt.$context;
			if (again.socialProviders.some((provider) => provider.id === PROVIDER_ID))
				return rebuilt;
		}
	}
	log.warning("the identity provider is not registered; discovery failed");
	return null;
}
