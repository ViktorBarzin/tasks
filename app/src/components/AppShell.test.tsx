import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "./AppShell";

test("renders the heading and responds to a tap", async () => {
	render(<AppShell />);
	expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "Tap" }));
	expect(screen.getByTestId("taps")).toHaveTextContent("1");
});
