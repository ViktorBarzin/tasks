/**
 * The identity bridge against a real Postgres (TEST_DATABASE_URL), and the
 * tasks group names fed to @viktorbarzin/auth.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { membershipFromGroups } from "@viktorbarzin/auth";

import {
	migratedTestDatabase,
	type TestDatabase,
	testDatabaseUrl,
} from "#/test/postgres.server";
import { authConfig } from "../config.server";
import { getDb } from "../db/client.server";
import { accountKeyForSubject } from "./identity.server";

describe("tasks group names", () => {
	const { groups } = authConfig(getDb, undefined);

	test("users, admins and agents are members; only admins are admins", () => {
		expect(membershipFromGroups(["Tasks Users"], groups)).toEqual({
			member: true,
			admin: false,
		});
		expect(membershipFromGroups(["Tasks Admins"], groups)).toEqual({
			member: true,
			admin: true,
		});
		expect(membershipFromGroups(["Tasks Agents"], groups)).toEqual({
			member: true,
			admin: false,
		});
		expect(membershipFromGroups(["Home Server Admins"], groups)).toEqual({
			member: false,
			admin: false,
		});
	});
});

describe.skipIf(!testDatabaseUrl)("identity bridge", () => {
	let pg: TestDatabase;

	beforeAll(async () => {
		pg = await migratedTestDatabase();
	}, 30_000);

	afterAll(async () => {
		await pg?.drop();
	});

	test("concurrent first requests for one subject end on one key", async () => {
		const keys = await Promise.all(
			Array.from({ length: 8 }, () =>
				accountKeyForSubject(pg.db, "sub-race", "race@example.com"),
			),
		);
		expect(new Set(keys)).toEqual(new Set(["race@example.com"]));
	});

	test("the link is made once: a renamed user keeps their key", async () => {
		expect(
			await accountKeyForSubject(pg.db, "sub-rename", "old@example.com"),
		).toBe("old@example.com");
		expect(
			await accountKeyForSubject(pg.db, "sub-rename", "new@example.com"),
		).toBe("old@example.com");
	});

	test("a taken username gets a key of its own", async () => {
		await accountKeyForSubject(pg.db, "sub-first", "taken@example.com");
		expect(
			await accountKeyForSubject(pg.db, "sub-second", "taken@example.com"),
		).toBe("sub:sub-second");
	});
});
