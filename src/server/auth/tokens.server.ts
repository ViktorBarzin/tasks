/**
 * API tokens for non-browser clients: Authentik-issued JWTs (ADR-0001,
 * Identity and access / API tokens). The verifier pins `RS256`, the
 * provider's issuer, `aud` equal to one of the app's client IDs (Authentik
 * 2026.8.3 sets `aud` to `client_id`) and `exp`, using the provider's JWKS
 * (jose `createRemoteJWKSet`). People's CLIs use device-code login; agents and
 * Home Assistant use service accounts in the `Tasks Agents` group.
 *
 * The issuer and jwks_uri come from OIDC_DISCOVERY_URL, fetched once and kept
 * for the life of the process (a failed fetch is retried on the next request).
 */
import {
	createRemoteJWKSet,
	type JWTPayload,
	type JWTVerifyGetKey,
	errors as joseErrors,
	jwtVerify,
} from "jose";

import { getLogger } from "../logging.server";
import { tokenVerificationsTotal } from "./auth-metrics.server";
import { getTokenSettings } from "./config.server";

const log = getLogger("tasks.tokens");

export interface TokenVerifierConfig {
	issuer: string;
	jwksUrl: string;
	audiences: string[];
}

/** The claims the app reads from a verified token. */
export interface VerifiedToken {
	sub: string;
	preferredUsername: string;
	/** The `groups` claim when the token carries one. */
	groups: unknown;
}

export const PINNED_ALGORITHMS = ["RS256"];

/** A verifier for one issuer. Returns null for any token it refuses. */
export function createTokenVerifier(
	config: TokenVerifierConfig,
	keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl)),
): (token: string) => Promise<VerifiedToken | null> {
	return async (token) => {
		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(token, keys, {
				algorithms: PINNED_ALGORITHMS,
				issuer: config.issuer,
				audience: config.audiences,
				requiredClaims: ["exp", "sub"],
			}));
		} catch (err) {
			const outcome =
				err instanceof joseErrors.JWTExpired
					? "expired"
					: err instanceof joseErrors.JWTClaimValidationFailed
						? `bad_${err.claim}`
						: err instanceof joseErrors.JOSEAlgNotAllowed
							? "bad_alg"
							: "invalid";
			tokenVerificationsTotal.inc({ outcome });
			log.info("bearer token refused", { reason: outcome });
			return null;
		}
		const sub = payload.sub;
		const preferredUsername = payload.preferred_username;
		if (
			typeof sub !== "string" ||
			sub === "" ||
			typeof preferredUsername !== "string"
		) {
			tokenVerificationsTotal.inc({ outcome: "missing_claims" });
			return null;
		}
		tokenVerificationsTotal.inc({ outcome: "ok" });
		return { sub, preferredUsername, groups: payload.groups };
	};
}

interface Discovery {
	issuer: string;
	jwks_uri: string;
}

/** Fetch and check the provider's discovery document. */
export async function fetchDiscovery(discoveryUrl: string): Promise<Discovery> {
	const response = await fetch(discoveryUrl, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error(`discovery answered ${response.status}`);
	const body = (await response.json()) as Partial<Discovery>;
	if (typeof body.issuer !== "string" || typeof body.jwks_uri !== "string") {
		throw new Error("discovery has no issuer or jwks_uri");
	}
	return {
		issuer: body.issuer,
		jwks_uri: new URL(body.jwks_uri, discoveryUrl).toString(),
	};
}

let cached: {
	key: string;
	verify: Promise<(token: string) => Promise<VerifiedToken | null>>;
} | null = null;

function verifierFor(discoveryUrl: string, audiences: string[]) {
	const key = `${discoveryUrl}|${audiences.join(",")}`;
	if (cached?.key !== key) {
		const verify = fetchDiscovery(discoveryUrl).then((found) =>
			createTokenVerifier({
				issuer: found.issuer,
				jwksUrl: found.jwks_uri,
				audiences,
			}),
		);
		verify.catch((err) => {
			log.warning("cannot read the OIDC discovery document", {
				error: String(err),
			});
			if (cached?.verify === verify) cached = null;
		});
		cached = { key, verify };
	}
	return cached.verify;
}

/** The bearer token in `Authorization`, or null when there is none. */
export function bearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;
	const match = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
	return match ? (match[1] as string) : null;
}

/**
 * The verified claims behind `Authorization: Bearer <jwt>`, or null when the
 * header is absent, malformed or the token is refused.
 */
export async function verifyBearerRequest(
	request: Request,
): Promise<VerifiedToken | null> {
	const token = bearerToken(request);
	if (!token) return null;
	const settings = getTokenSettings();
	if (!settings) {
		tokenVerificationsTotal.inc({ outcome: "not_configured" });
		return null;
	}
	let verify: (token: string) => Promise<VerifiedToken | null>;
	try {
		verify = await verifierFor(settings.discoveryUrl, settings.audiences);
	} catch {
		tokenVerificationsTotal.inc({ outcome: "no_discovery" });
		return null;
	}
	return verify(token);
}
