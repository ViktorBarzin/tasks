/**
 * Thin JSON client for THE API CONTRACT. Identity comes from the
 * X-Authentik-Username header injected by the forward-auth proxy (or the
 * backend's DEV_USER fallback in dev) — the client never sends credentials
 * beyond the session cookie.
 */
import type { Me, Op, OpsResponse, SyncPayload } from './types';

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

/**
 * The Authentik forward-auth wall, distinct from being offline or a bad
 * Nextcloud password: the session with the SSO expired, so a request was
 * bounced to the login page. Remediation is a full navigation to '/', which
 * reaches Traefik→Authentik (contract-delta §I).
 */
export class AuthWallError extends Error {
	constructor() {
		super('auth-wall');
		this.name = 'AuthWallError';
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		credentials: 'same-origin',
		// Don't transparently follow the Authentik bounce to the SSO login (which
		// returns 200 HTML and mimics a corrupt API reply). With manual redirect a
		// cross-origin 3xx surfaces as an opaque redirect we can detect (§I).
		redirect: 'manual',
		...init,
		headers: {
			accept: 'application/json',
			...(init?.body ? { 'content-type': 'application/json' } : {})
		}
	});
	// Session expired: Traefik→Authentik redirected us to its login page.
	if (res.type === 'opaqueredirect') throw new AuthWallError();
	if (!res.ok) throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} → ${res.status}`);
	if (res.status === 204) return undefined as T;
	// An OK response that isn't JSON is the SSO login HTML served in place of the
	// API (a same-origin wall that doesn't redirect) — the auth wall, not data.
	const contentType = res.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) throw new AuthWallError();
	return (await res.json()) as T;
}

export const api = {
	me(): Promise<Me> {
		return request<Me>('/api/me');
	},

	/** 204 on success; 401 (ApiError) when the credential fails live validation. */
	onboard(nc_username: string, app_password: string): Promise<void> {
		return request<void>('/api/onboard', {
			method: 'POST',
			body: JSON.stringify({ nc_username, app_password })
		});
	},

	/** Empty cursor ⇒ full snapshot. */
	sync(cursor: string): Promise<SyncPayload> {
		return request<SyncPayload>(`/api/sync?cursor=${encodeURIComponent(cursor)}`);
	},

	ops(ops: Op[]): Promise<OpsResponse> {
		return request<OpsResponse>('/api/ops', {
			method: 'POST',
			body: JSON.stringify({ ops })
		});
	}
};
