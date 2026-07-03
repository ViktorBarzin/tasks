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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		credentials: 'same-origin',
		...init,
		headers: {
			accept: 'application/json',
			...(init?.body ? { 'content-type': 'application/json' } : {})
		}
	});
	if (!res.ok) throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} → ${res.status}`);
	if (res.status === 204) return undefined as T;
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
