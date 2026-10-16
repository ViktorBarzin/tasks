/** The applied_ops journal against a real Postgres (TEST_DATABASE_URL). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	migratedTestDatabase,
	type TestDatabase,
	testDatabaseUrl,
} from "#/test/postgres.server";
import { drizzleJournal } from "./journal.server";

describe.skipIf(!testDatabaseUrl)("drizzleJournal", () => {
	let pg: TestDatabase;

	beforeAll(async () => {
		pg = await migratedTestDatabase();
	}, 30_000);

	afterAll(async () => {
		await pg?.drop();
	}, 30_000);

	test("records once; a second insert of the same op_id reports the race", async () => {
		const journal = drizzleJournal(pg.db);
		expect(
			await journal.record("viktor", "op-1", "task_create", "applied"),
		).toBe(true);
		expect(
			await journal.record("viktor", "op-1", "task_create", "duplicate"),
		).toBe(false);
		const rows = await pg.client`
			select authentik_username, op_id, kind, status from applied_ops
			where op_id = 'op-1'`;
		expect(rows).toEqual([
			{
				authentik_username: "viktor",
				op_id: "op-1",
				kind: "task_create",
				status: "applied",
			},
		]);
	});

	test("the pre-check returns only this account's journaled ids", async () => {
		const journal = drizzleJournal(pg.db);
		await journal.record("anca", "shared-id", "list_create", "applied");
		await journal.record("viktor", "mine", "list_create", "duplicate");
		expect(
			await journal.journaledOpIds("viktor", [
				"mine",
				"shared-id",
				"mine",
				"new",
			]),
		).toEqual(new Set(["mine"]));
		expect(await journal.journaledOpIds("viktor", [])).toEqual(new Set());
	});

	test("reads rows the Python backend wrote", async () => {
		await pg.client`
			insert into applied_ops (authentik_username, op_id, kind, status)
			values ('viktor', 'from-python', 'task_complete', 'lww_reapplied')`;
		const journal = drizzleJournal(pg.db);
		expect(await journal.journaledOpIds("viktor", ["from-python"])).toEqual(
			new Set(["from-python"]),
		);
	});
});
