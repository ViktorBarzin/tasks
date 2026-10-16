/**
 * Thin JSON client for THE API CONTRACT (src/shared/contract.ts). Identity is
 * the session cookie the server issues after OIDC sign-in; the client sends
 * nothing else.
 *
 * Session expiry is detected by a 401 (ADR-0001, Pilot / Client continuity).
 * The Svelte build sat behind forward-auth and detected the Authentik bounce
 * as an `opaqueredirect`; this server answers /api without a session with a
 * 401 `unauthorized` envelope instead, and redirects are not special.
 */
import { CLIENT_ID_HEADER, type ErrorEnvelope } from "#/shared/contract";

import type { Me, Op, OpsResponse, SyncPayload } from "./types";

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		/** The envelope's `error.code`, when the body carried one. */
		public readonly code: string | null = null,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * No live session: distinct from being offline and from a revoked Nextcloud
 * app password. Remediation is signing in again (src/client/signin.ts).
 */
export class AuthWallError extends Error {
	constructor() {
		super("auth-wall");
		this.name = "AuthWallError";
	}
}

/**
 * 401 codes that are NOT about the session: Nextcloud rejected the stored app
 * password (the client shows "reconnect"), or the one being onboarded.
 */
const NON_SESSION_401 = new Set([
	"nextcloud_unauthorized",
	"invalid_credentials",
]);

let id: string | null = null;

/**
 * This tab's id, sent with POST /api/ops so the realtime poke those ops cause
 * can be told apart from another device's (src/client/realtime.ts).
 */
export function clientId(): string {
	id ??= crypto.randomUUID();
	return id;
}

async function errorCode(res: Response): Promise<string | null> {
	try {
		const body = (await res.json()) as Partial<ErrorEnvelope>;
		return typeof body.error?.code === "string" ? body.error.code : null;
	} catch {
		return null;
	}
}

async function request<T>(
	path: string,
	init?: RequestInit,
	extraHeaders: Record<string, string> = {},
): Promise<T> {
	const res = await fetch(path, {
		credentials: "same-origin",
		...init,
		headers: {
			accept: "application/json",
			...(init?.body ? { "content-type": "application/json" } : {}),
			...extraHeaders,
		},
	});
	const label = `${init?.method ?? "GET"} ${path} → ${res.status}`;
	if (res.status === 401) {
		const code = await errorCode(res);
		if (code !== null && NON_SESSION_401.has(code))
			throw new ApiError(401, label, code);
		throw new AuthWallError();
	}
	if (!res.ok) throw new ApiError(res.status, label, await errorCode(res));
	if (res.status === 204) return undefined as T;
	// An OK response that isn't JSON is a login page served in place of the
	// API, not data.
	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) throw new AuthWallError();
	return (await res.json()) as T;
}

export const api = {
	me(): Promise<Me> {
		return request<Me>("/api/me");
	},

	/** 204 on success; 401 `invalid_credentials` (ApiError) when the credential fails live validation. */
	onboard(nc_username: string, app_password: string): Promise<void> {
		return request<void>("/api/onboard", {
			method: "POST",
			body: JSON.stringify({ nc_username, app_password }),
		});
	},

	/** Empty cursor ⇒ full snapshot. */
	sync(cursor: string): Promise<SyncPayload> {
		return request<SyncPayload>(
			`/api/sync?cursor=${encodeURIComponent(cursor)}`,
		);
	},

	ops(ops: Op[]): Promise<OpsResponse> {
		return request<OpsResponse>(
			"/api/ops",
			{ method: "POST", body: JSON.stringify({ ops }) },
			{ [CLIENT_ID_HEADER]: clientId() },
		);
	},
};
