import { describe, expect, it, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AlertPrompt } from "./AlertPrompt";

describe("AlertPrompt", () => {
	it("typed confirm: Delete stays disabled until the name matches exactly", async () => {
		const onConfirm = mock((_v: string) => {});
		render(
			<AlertPrompt
				open
				title="Delete List?"
				confirmLabel="Delete"
				danger
				requireMatch="Groceries"
				onConfirm={onConfirm}
				onCancel={() => {}}
			/>,
		);
		const dialog = screen.getByRole("alertdialog", { name: "Delete List?" });
		expect(dialog).toBeInTheDocument();
		const del = screen.getByRole("button", { name: "Delete" });
		expect(del).toBeDisabled();
		// The prompt selects its text 60 ms after opening, like the Svelte build.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await userEvent.type(screen.getByRole("textbox"), "Grocerie");
		expect(del).toBeDisabled();
		await userEvent.type(screen.getByRole("textbox"), "s");
		expect(del).toBeEnabled();
		await userEvent.click(del);
		expect(onConfirm).toHaveBeenCalledWith("Groceries");
	});

	it("a prompt opens with its initial value, confirms on Enter, cancels on the scrim", async () => {
		const onConfirm = mock((_v: string) => {});
		const onCancel = mock(() => {});
		render(
			<AlertPrompt
				open
				title="Rename List"
				withInput
				initial="Errands"
				confirmLabel="Rename"
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		const input = screen.getByRole("textbox");
		expect(input).toHaveValue("Errands");
		// The prompt selects its text 60 ms after opening, like the Svelte build.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await userEvent.clear(input);
		await userEvent.type(input, "Chores{Enter}");
		expect(onConfirm).toHaveBeenCalledWith("Chores");
		const scrim = document.querySelector<HTMLElement>(
			".alert-overlay > .scrim",
		);
		if (!scrim) throw new Error("no scrim");
		await userEvent.click(scrim);
		expect(onCancel).toHaveBeenCalled();
	});
});
