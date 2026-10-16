/**
 * API tokens for non-browser clients: Authentik-issued JWTs (ADR-0001,
 * Identity and access / API tokens). The verifier pins `RS256`, the
 * provider's issuer, `aud` equal to one of the app's client IDs (Authentik
 * 2026.8.3 sets `aud` to `client_id`) and `exp`, using the provider's JWKS
 * (jose `createRemoteJWKSet`). People's CLIs use device-code login; agents and
 * Home Assistant use service accounts in the `Tasks Agents` group.
 */
import { notImplemented } from "../not-implemented.server";
import type { AuthUser } from "./user.server";

export interface TokenVerifierConfig {
	issuer: string;
	jwksUrl: string;
	audiences: string[];
}

/** The user behind `Authorization: Bearer <jwt>`, or null when the header is absent. Invalid tokens: null. */
export async function verifyBearerRequest(
	request: Request,
): Promise<AuthUser | null> {
	if (!request.headers.get("authorization")) return null;
	return notImplemented("verifyBearerRequest");
}
