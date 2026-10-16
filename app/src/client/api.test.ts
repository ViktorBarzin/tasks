import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	mock,
} from "bun:test";

import { CLIENT_ID_HEADER } from "#/shared/contract";

import { ApiError, AuthWallError, api, clientId } from "./api";

let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const realFetch = globalThis.fetch;

beforeEach(() => {
	fetchMock = mock();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function envelope(code: string, status: number): Response {
	return jsonResponse({ error: { code, message: code } }, status);
}

describe("api session detection (tasks ADR-0003/0004, now by 401)", () => {
	it("returns parsed JSON for a normal ok response", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ username: "viktor", connected: true }),
		);
		await expect(api.me()).resolves.toEqual({
			username: "viktor",
			connected: true,
		});
	});

	it("throws AuthWallError on a 401 `unauthorized` envelope (no session)", async () => {
		fetchMock.mockResolvedValue(envelope("unauthorized", 401));
		await expect(api.me()).rejects.toBeInstanceOf(AuthWallError);
	});

	it("treats a 401 with no readable envelope as the auth wall too", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
		await expect(api.sync("")).rejects.toBeInstanceOf(AuthWallError);
	});

	it("throws ApiError(401), not AuthWallError, when Nextcloud rejects the stored password", async () => {
		fetchMock.mockResolvedValue(envelope("nextcloud_unauthorized", 401));
		const err = await api.sync("c").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(401);
		expect((err as ApiError).code).toBe("nextcloud_unauthorized");
	});

	it("throws ApiError(401) for an onboarding credential Nextcloud rejected", async () => {
		fetchMock.mockResolvedValue(envelope("invalid_credentials", 401));
		const err = await api.onboard("u", "p").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).code).toBe("invalid_credentials");
	});

	it("throws AuthWallError on an ok but non-JSON body (a login page in place of the API)", async () => {
		fetchMock.mockResolvedValue(
			new Response("<!doctype html><title>Sign in</title>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		await expect(api.me()).rejects.toBeInstanceOf(AuthWallError);
	});

	it("carries the envelope code on other errors", async () => {
		fetchMock.mockResolvedValue(envelope("not_connected", 409));
		const err = await api.sync("").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(409);
		expect((err as ApiError).code).toBe("not_connected");
	});

	it("accepts a 204 (no content) without demanding JSON: onboard success", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		await expect(api.onboard("u", "p")).resolves.toBeUndefined();
	});
});

describe("request shape (the frozen JSON contract)", () => {
	it("GETs /api/sync with the cursor url-encoded", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ cursor: "c2", full: false, lists: [], tasks: [] }),
		);
		await api.sync("a+b/c=");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sync?cursor=a%2Bb%2Fc%3D");
	});

	it("POSTs ops as {ops} JSON and names this device for realtime pokes", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
		const op = { op_id: "o1", kind: "task_delete", uid: "t1" } as const;
		await api.ops([op]);
		const [path, init] = fetchMock.mock.calls[0] ?? [];
		expect(path).toBe("/api/ops");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe(JSON.stringify({ ops: [op] }));
		const headers = new Headers(init?.headers);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get(CLIENT_ID_HEADER)).toBe(clientId());
	});

	it("follows redirects normally (no opaqueredirect handling any more)", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ username: "v", connected: true }),
		);
		await api.me();
		expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBeUndefined();
	});
});
