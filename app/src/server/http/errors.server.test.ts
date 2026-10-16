import { expect, test } from "bun:test";

import { onboardRequestSchema, opsRequestSchema } from "#/shared/contract";
import { CalDAVUnauthorized } from "../caldav/engine.server";
import { readJson } from "./api.server";
import { ApiError, toErrorResponse } from "./errors.server";

const req = (body: string) =>
	new Request("http://localhost/api/onboard", { method: "POST", body });

test("ApiError becomes the envelope", async () => {
	const res = toErrorResponse(
		new ApiError(409, "not_connected", "nope"),
		req(""),
	);
	expect(res.status).toBe(409);
	expect(await res.text()).toBe(
		'{"error":{"code":"not_connected","message":"nope"}}',
	);
});

test("a rejected stored credential is 401 nextcloud_unauthorized", async () => {
	const res = toErrorResponse(new CalDAVUnauthorized("401"), req(""));
	expect(res.status).toBe(401);
	expect((await res.json()).error.code).toBe("nextcloud_unauthorized");
});

test("validation errors name the field but never echo the app password", async () => {
	const secret = "s3cret-app-password";
	const err = await readJson(
		req(JSON.stringify({ app_password: secret })),
		onboardRequestSchema,
	).catch((e: unknown) => e);
	expect(err).toBeInstanceOf(ApiError);
	expect((err as ApiError).status).toBe(422);
	expect((err as ApiError).message).toContain("body.nc_username");
	expect((err as ApiError).message).not.toContain(secret);
});

test("an unknown op kind passes batch validation (it becomes a per-op error)", () => {
	const parsed = opsRequestSchema.parse({
		ops: [{ op_id: "1", kind: "task_teleport", uid: null, extra_field: 5 }],
	});
	expect(parsed.ops[0]).toMatchObject({
		kind: "task_teleport",
		extra_field: 5,
	});
});
