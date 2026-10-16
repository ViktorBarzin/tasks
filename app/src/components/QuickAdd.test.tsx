import { describe, expect, it, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import type { Priority } from "#/client/types";

import { QuickAdd } from "./QuickAdd";

function Harness({
	onAdd,
}: {
	onAdd: (f: { title: string; priority: Priority }) => Promise<unknown>;
}) {
	const [text, setText] = useState("");
	const [priority, setPriority] = useState<Priority>(0);
	return (
		<QuickAdd
			text={text}
			onTextChange={setText}
			priority={priority}
			onPriorityChange={setPriority}
			onAdd={onAdd}
		/>
	);
}

describe("QuickAdd", () => {
	it("cycles priority None → Low → Medium → High → None", async () => {
		render(<Harness onAdd={mock(async () => {})} />);
		const names: string[] = [];
		for (let i = 0; i < 5; i++) {
			const button = screen.getByRole("button", { name: /^Priority:/ });
			names.push(button.getAttribute("aria-label") ?? "");
			await userEvent.click(button);
		}
		expect(names).toEqual([
			"Priority: None",
			"Priority: Low",
			"Priority: Medium",
			"Priority: High",
			"Priority: None",
		]);
	});

	it("adds the trimmed title with its priority on return, then clears the draft", async () => {
		const onAdd = mock(async (_f: { title: string; priority: Priority }) => {});
		render(<Harness onAdd={onAdd} />);
		await userEvent.click(
			screen.getByRole("button", { name: "Priority: None" }),
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "New task title" }),
			"  Milk  {Enter}",
		);
		expect(onAdd).toHaveBeenCalledWith({ title: "Milk", priority: 9 });
		expect(screen.getByRole("textbox", { name: "New task title" })).toHaveValue(
			"",
		);
		expect(
			screen.getByRole("button", { name: "Priority: None" }),
		).toBeInTheDocument();
	});

	it("ignores an empty submit", async () => {
		const onAdd = mock(async () => {});
		render(<Harness onAdd={onAdd} />);
		await userEvent.type(
			screen.getByRole("textbox", { name: "New task title" }),
			"   {Enter}",
		);
		expect(onAdd).not.toHaveBeenCalled();
	});
});
