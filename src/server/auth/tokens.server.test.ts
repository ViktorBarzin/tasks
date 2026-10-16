import { describe, expect, test } from "bun:test";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JWTPayload,
	SignJWT,
	UnsecuredJWT,
} from "jose";

import { bearerToken, createTokenVerifier } from "./tokens.server";

const ISSUER = "https://authentik.example/application/o/tasks/";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({
	keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }],
});
const verify = createTokenVerifier(
	{
		issuer: ISSUER,
		jwksUrl: "https://unused.example/jwks",
		audiences: ["tasks-web", "tasks-cli"],
	},
	jwks,
);
const claims = {
	sub: "abc123",
	preferred_username: "viktor@example.com",
	groups: ["Tasks Users"],
};

function sign(payload: JWTPayload, edit: (jwt: SignJWT) => SignJWT = (j) => j) {
	return edit(
		new SignJWT(payload)
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("tasks-web")
			.setIssuedAt()
			.setExpirationTime("15m"),
	).sign(privateKey);
}

describe("createTokenVerifier", () => {
	test("accepts an RS256 token for the app and returns its claims", async () => {
		expect(await verify(await sign(claims))).toEqual({
			sub: "abc123",
			preferredUsername: "viktor@example.com",
			groups: ["Tasks Users"],
		});
	});

	test("accepts any of the app's client IDs as aud", async () => {
		expect(
			await verify(await sign(claims, (j) => j.setAudience("tasks-cli"))),
		).not.toBeNull();
	});

	test.each([
		["another audience", (j: SignJWT) => j.setAudience("grafana")],
		["another issuer", (j: SignJWT) => j.setIssuer("https://evil.example/")],
		[
			"an expired token",
			(j: SignJWT) => j.setExpirationTime(Math.floor(Date.now() / 1000) - 120),
		],
	])("refuses %s", async (_name, edit) => {
		expect(await verify(await sign(claims, edit))).toBeNull();
	});

	test("refuses a token without exp", async () => {
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("tasks-web")
			.sign(privateKey);
		expect(await verify(token)).toBeNull();
	});

	test("refuses alg none", async () => {
		const token = new UnsecuredJWT(claims)
			.setIssuer(ISSUER)
			.setAudience("tasks-web")
			.setExpirationTime("15m")
			.encode();
		expect(await verify(token)).toBeNull();
	});

	test("refuses HS256 even when signed with the public key's bytes", async () => {
		const secret = new TextEncoder().encode(
			JSON.stringify(await exportJWK(publicKey)),
		);
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "HS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("tasks-web")
			.setExpirationTime("15m")
			.sign(secret);
		expect(await verify(token)).toBeNull();
	});

	test("refuses a token without preferred_username", async () => {
		expect(await verify(await sign({ sub: "abc123" }))).toBeNull();
	});

	test("refuses a token signed by an unknown key", async () => {
		const other = await generateKeyPair("RS256");
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("tasks-web")
			.setExpirationTime("15m")
			.sign(other.privateKey);
		expect(await verify(token)).toBeNull();
	});
});

describe("bearerToken", () => {
	const with_ = (value: string) =>
		new Request("http://x/api/me", { headers: { authorization: value } });

	test("reads a bearer token", () => {
		expect(bearerToken(with_("Bearer a.b.c"))).toBe("a.b.c");
		expect(bearerToken(with_("bearer a.b.c"))).toBe("a.b.c");
	});

	test("ignores other schemes and junk", () => {
		expect(bearerToken(with_("Basic dXNlcjpwYXNz"))).toBeNull();
		expect(bearerToken(with_("Bearer a b"))).toBeNull();
		expect(bearerToken(new Request("http://x/"))).toBeNull();
	});
});
