/**
 * Identity bridge, membership and request + approve against a real Postgres
 * (TEST_DATABASE_URL) and the mock Authentik API.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { SQL } from "bun";

import { createDb, createSqlClient, type Db } from "../db/client.server";
import { runMigrations } from "../db/migrate.server";
import { ApiError } from "../http/errors.server";
import {
	approveRequest,
	fileAccessRequest,
	listPendingRequests,
} from "./access.server";
import { accountKeyForSubject } from "./identity.server";
import {
	currentMembership,
	membershipFromGroups,
	saveMemberCheck,
} from "./membership.server";
import { MIGRATIONS_DIR, TestDatabases } from "./testing/built-server";
import {
	type MockAuthentik,
	startMockAuthentik,
} from "./testing/mock-authentik";
import type { AuthUser } from "./user.server";

const adminUrl = process.env.TEST_DATABASE_URL;
let dbs: TestDatabases;
let client: SQL;
let db: Db;
let mock: MockAuthentik;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined) {
	if (!(name in savedEnv)) savedEnv[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeAll(async () => {
	if (!adminUrl) return;
	dbs = new TestDatabases(adminUrl);
	const url = await dbs.create();
	setEnv("DATABASE_URL", url);
	client = createSqlClient({ max: 4 });
	const migrator = createSqlClient({ max: 1 });
	await runMigrations(migrator, MIGRATIONS_DIR);
	await migrator.close();
	db = createDb(client);
	mock = await startMockAuthentik();
	setEnv("AUTHENTIK_API_URL", mock.apiUrl);
	setEnv("AUTHENTIK_READER_TOKEN", mock.readerToken);
	setEnv("AUTHENTIK_APPROVER_TOKEN", mock.approverToken);
	setEnv("AUTHENTIK_USERS_GROUP_PK", undefined);
});

afterAll(async () => {
	if (!adminUrl) return;
	await client.close();
	await mock.stop();
	await dbs.dropAll();
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

beforeEach(() => {
	if (mock) {
		mock.apiCalls.length = 0;
		mock.apiFailure = null;
	}
});

function adminUser(sub: string, username: string): AuthUser {
	return {
		sub,
		username,
		accountKey: username,
		via: "session",
		member: true,
		admin: true,
	};
}

describe("membershipFromGroups", () => {
	test("users, admins and agents are members; only admins are admins", () => {
		expect(membershipFromGroups(["Tasks Users"])).toEqual({
			member: true,
			admin: false,
		});
		expect(membershipFromGroups(["Tasks Admins"])).toEqual({
			member: true,
			admin: true,
		});
		expect(membershipFromGroups(["Tasks Agents"])).toEqual({
			member: true,
			admin: false,
		});
		expect(membershipFromGroups(["Home Server Admins"])).toEqual({
			member: false,
			admin: false,
		});
	});
});

describe.skipIf(!adminUrl)("identity bridge", () => {
	test("concurrent first requests for one subject end on one key", async () => {
		const keys = await Promise.all(
			Array.from({ length: 8 }, () =>
				accountKeyForSubject(db, "sub-race", "race@example.com"),
			),
		);
		expect(new Set(keys)).toEqual(new Set(["race@example.com"]));
	});

	test("the link is made once: a renamed user keeps their key", async () => {
		expect(
			await accountKeyForSubject(db, "sub-rename", "old@example.com"),
		).toBe("old@example.com");
		expect(
			await accountKeyForSubject(db, "sub-rename", "new@example.com"),
		).toBe("old@example.com");
	});

	test("a taken username gets a key of its own", async () => {
		await accountKeyForSubject(db, "sub-first", "taken@example.com");
		expect(
			await accountKeyForSubject(db, "sub-second", "taken@example.com"),
		).toBe("sub:sub-second");
	});
});

describe.skipIf(!adminUrl)("membership re-check", () => {
	test("a fresh answer is used without asking Authentik", async () => {
		await saveMemberCheck(
			db,
			"sub-fresh",
			"fresh@example.com",
			{ member: true, admin: false },
			"id_token",
		);
		expect(
			await currentMembership(db, "sub-fresh", "fresh@example.com"),
		).toEqual({ member: true, admin: false });
		expect(mock.apiCalls).toHaveLength(0);
	});

	test("a stale answer is re-asked once for concurrent callers", async () => {
		const user = mock.addUser({
			username: "stale@example.com",
			groups: ["Tasks Admins"],
		});
		await saveMemberCheck(
			db,
			user.uid,
			user.username,
			{ member: false, admin: false },
			"api",
			new Date(Date.now() - 20 * 60_000),
		);
		const answers = await Promise.all(
			Array.from({ length: 5 }, () =>
				currentMembership(db, user.uid, user.username),
			),
		);
		expect(answers.every((a) => a.member && a.admin)).toBe(true);
		expect(mock.apiCalls).toHaveLength(1);
	});

	test("a user whose uid does not match the sub is not a member", async () => {
		mock.addUser({ username: "imposter@example.com", groups: ["Tasks Users"] });
		expect(
			await currentMembership(db, "some-other-sub", "imposter@example.com", {
				maxAgeMs: 0,
			}),
		).toEqual({
			member: false,
			admin: false,
		});
	});

	test("an inactive user is not a member", async () => {
		const user = mock.addUser({
			username: "off@example.com",
			groups: ["Tasks Users"],
			isActive: false,
		});
		expect(
			(await currentMembership(db, user.uid, user.username, { maxAgeMs: 0 }))
				.member,
		).toBe(false);
	});

	test("an outage keeps the last answer; with none, not a member", async () => {
		const user = mock.addUser({ username: "outage@example.com", groups: [] });
		await saveMemberCheck(
			db,
			user.uid,
			user.username,
			{ member: true, admin: false },
			"api",
			new Date(0),
		);
		mock.apiFailure = 500;
		expect((await currentMembership(db, user.uid, user.username)).member).toBe(
			true,
		);
		expect(
			(await currentMembership(db, "never-seen", "nobody@example.com")).member,
		).toBe(false);
	});

	test("a 403 from Authentik (token missing a permission) is not a removal", async () => {
		const user = mock.addUser({ username: "perm@example.com", groups: [] });
		await saveMemberCheck(
			db,
			user.uid,
			user.username,
			{ member: true, admin: false },
			"api",
			new Date(0),
		);
		setEnv("AUTHENTIK_READER_TOKEN", "wrong-token");
		try {
			expect(
				(await currentMembership(db, user.uid, user.username)).member,
			).toBe(true);
		} finally {
			setEnv("AUTHENTIK_READER_TOKEN", mock.readerToken);
		}
	});
});

describe.skipIf(!adminUrl)("request + approve", () => {
	test("an admin approves: the approver token adds the user to Tasks Users", async () => {
		const admin = mock.addUser({
			username: "boss@example.com",
			groups: ["Tasks Admins"],
		});
		const asker = mock.addUser({ username: "asker@example.com", groups: [] });
		await saveMemberCheck(
			db,
			admin.uid,
			admin.username,
			{ member: true, admin: true },
			"id_token",
		);
		await fileAccessRequest(db, {
			sub: asker.uid,
			username: asker.username,
			email: asker.email,
			name: "Asker",
		});

		const pending = await listPendingRequests(
			db,
			adminUser(admin.uid, admin.username),
		);
		expect(pending.map((p) => p.username)).toContain("asker@example.com");

		mock.apiCalls.length = 0;
		await approveRequest(db, adminUser(admin.uid, admin.username), asker.uid);
		expect(asker.groups).toEqual(["Tasks Users"]);
		const add = mock.apiCalls.find((c) => c.path.endsWith("/add_user/"));
		expect(add).toEqual({
			method: "POST",
			path: `/core/groups/${mock.usersGroupPk}/add_user/`,
			token: mock.approverToken,
		});
		expect(await currentMembership(db, asker.uid, asker.username)).toEqual({
			member: true,
			admin: false,
		});
		const after = await listPendingRequests(
			db,
			adminUser(admin.uid, admin.username),
		);
		expect(after.map((p) => p.username)).not.toContain("asker@example.com");
	});

	test("a non-admin cannot list or approve", async () => {
		const member = mock.addUser({
			username: "member@example.com",
			groups: ["Tasks Users"],
		});
		await saveMemberCheck(
			db,
			member.uid,
			member.username,
			{ member: true, admin: false },
			"id_token",
		);
		const user = { ...adminUser(member.uid, member.username), admin: false };
		await expect(listPendingRequests(db, user)).rejects.toMatchObject({
			status: 403,
			code: "forbidden",
		});
		await expect(approveRequest(db, user, "anything")).rejects.toBeInstanceOf(
			ApiError,
		);
	});

	test("approving someone whose account is gone is a conflict, and nothing is added", async () => {
		const admin = mock.addUser({
			username: "boss2@example.com",
			groups: ["Tasks Admins"],
		});
		await saveMemberCheck(
			db,
			admin.uid,
			admin.username,
			{ member: true, admin: true },
			"id_token",
		);
		await fileAccessRequest(db, {
			sub: "ghost-sub",
			username: "ghost@example.com",
			email: null,
			name: null,
		});
		await expect(
			approveRequest(db, adminUser(admin.uid, admin.username), "ghost-sub"),
		).rejects.toMatchObject({
			status: 409,
		});
		expect(mock.apiCalls.some((c) => c.path.endsWith("/add_user/"))).toBe(
			false,
		);
	});

	test("an Authentik outage during approval is a 502 and leaves the request pending", async () => {
		const admin = mock.addUser({
			username: "boss3@example.com",
			groups: ["Tasks Admins"],
		});
		const asker = mock.addUser({ username: "asker3@example.com", groups: [] });
		await saveMemberCheck(
			db,
			admin.uid,
			admin.username,
			{ member: true, admin: true },
			"id_token",
		);
		await fileAccessRequest(db, {
			sub: asker.uid,
			username: asker.username,
			email: null,
			name: null,
		});
		mock.apiFailure = 503;
		await expect(
			approveRequest(db, adminUser(admin.uid, admin.username), asker.uid),
		).rejects.toMatchObject({
			status: 502,
		});
		mock.apiFailure = null;
		const pending = await listPendingRequests(
			db,
			adminUser(admin.uid, admin.username),
		);
		expect(pending.map((p) => p.sub)).toContain(asker.uid);
	});
});
