import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";

import * as db from "#/client/db";
import {
	_resetReplicaForTests,
	foldServerState,
	replica,
} from "#/client/replica";
import { get } from "#/client/store";
import { _resetSyncForTests } from "#/client/sync";
import type { Task } from "#/client/types";

import { TaskSheet } from "./TaskSheet";

const realFetch = globalThis.fetch;

function task(extra: Partial<Task> = {}): Task {
	return {
		uid: "t1",
		list_id: "l-a",
		title: "Milk",
		notes: "",
		due: null,
		due_has_time: false,
		priority: 0,
		sort_order: 1024,
		completed: false,
		completed_at: null,
		recurring: false,
		deleted: false,
		...extra,
	};
}

beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	db._resetForTests();
	_resetReplicaForTests();
	_resetSyncForTests();
	// Actions kick the sync engine; keep the network out of component tests.
	globalThis.fetch = (async () => {
		throw new TypeError("offline");
	}) as unknown as typeof fetch;
	await foldServerState({
		cursor: "c",
		full: true,
		lists: [
			{ id: "l-a", name: "Alpha", order: 0, sort_mode: null, deleted: false },
			{ id: "l-b", name: "Bravo", order: 1, sort_mode: null, deleted: false },
		],
		tasks: [task()],
	});
	return () => {
		globalThis.fetch = realFetch;
	};
});

describe("TaskSheet", () => {
	it("saving an edit emits only the changed fields, then a move with both endpoints", async () => {
		let closed = false;
		const t = get(replica).tasks.get("t1") as Task;
		render(<TaskSheet open task={t} onClose={() => (closed = true)} />);

		await userEvent.type(screen.getByPlaceholderText("Title"), " and eggs");
		await userEvent.click(screen.getByRole("radio", { name: "High" }));
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "List" }),
			"l-b",
		);
		await userEvent.click(screen.getByRole("button", { name: "Done" }));
		await waitFor(() => expect(closed).toBe(true));

		const ops = (await db.peekOps(10)).map((q) => q.op);
		expect(ops).toHaveLength(2);
		const [update, move] = ops;
		expect(update).toMatchObject({
			kind: "task_update",
			uid: "t1",
			title: "Milk and eggs",
			priority: 1,
		});
		expect(Object.keys(update as object).sort()).toEqual([
			"kind",
			"op_id",
			"priority",
			"title",
			"uid",
		]);
		expect(move).toMatchObject({
			kind: "task_move",
			uid: "t1",
			list_id: "l-a",
			to_list_id: "l-b",
		});
		expect(get(replica).tasks.get("t1")).toMatchObject({
			title: "Milk and eggs",
			list_id: "l-b",
		});
	});

	it("creating carries the full field set in one task_create", async () => {
		let closed = false;
		render(
			<TaskSheet
				open
				defaultListId="l-a"
				defaultTitle="Bread"
				onClose={() => {
					closed = true;
				}}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "New Task" }),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Today" }));
		await userEvent.click(screen.getByRole("button", { name: "Add" }));
		await waitFor(() => expect(closed).toBe(true));

		const [create] = (await db.peekOps(10)).map((q) => q.op);
		expect(create).toMatchObject({
			kind: "task_create",
			list_id: "l-a",
			title: "Bread",
			notes: "",
			due_has_time: false,
			priority: 0,
		});
		expect((create as { due: string }).due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
