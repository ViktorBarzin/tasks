import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, AuthWallError } from './api';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** A fetch Response as it appears with redirect:'manual' after a cross-origin
 * 3xx — status 0, not ok, type 'opaqueredirect'. */
function opaqueRedirect(): Response {
	return {
		type: 'opaqueredirect',
		ok: false,
		status: 0,
		headers: new Headers(),
		json: async () => ({})
	} as unknown as Response;
}

describe('api auth-wall detection (§I)', () => {
	it('returns parsed JSON for a normal ok response', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ username: 'viktor', connected: true }));
		await expect(api.me()).resolves.toEqual({ username: 'viktor', connected: true });
	});

	it('requests with redirect:manual so the Authentik bounce is observable', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ username: 'v', connected: false }));
		await api.me();
		expect(fetchMock).toHaveBeenCalledWith('/api/me', expect.objectContaining({ redirect: 'manual' }));
	});

	it('throws AuthWallError on an opaque redirect (SSO bounce)', async () => {
		fetchMock.mockResolvedValue(opaqueRedirect());
		await expect(api.me()).rejects.toBeInstanceOf(AuthWallError);
	});

	it('throws AuthWallError on an ok but non-JSON body (login HTML)', async () => {
		fetchMock.mockResolvedValue(
			new Response('<!doctype html><title>Sign in</title>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			})
		);
		await expect(api.me()).rejects.toBeInstanceOf(AuthWallError);
	});

	it('throws ApiError (not AuthWallError) on a real 401', async () => {
		fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
		const err = await api.me().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(401);
	});

	it('accepts a 204 (no content) without demanding JSON — onboard success', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		await expect(api.onboard('u', 'p')).resolves.toBeUndefined();
	});
});
