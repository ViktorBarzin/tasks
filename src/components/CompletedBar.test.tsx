import { afterAll, describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { setTrackForTests } from "#/client/events";

import { CompletedBar } from "./CompletedBar";

const sent: Array<[string, unknown]> = [];
const restore = setTrackForTests((name, properties) => {
	sent.push([name, properties]);
});
afterAll(() => restore());

describe("CompletedBar", () => {
	it("toggles and records which way (completed_tasks.toggled)", async () => {
		let toggled = 0;
		render(<CompletedBar count={2} shown={false} onToggle={() => toggled++} />);
		await userEvent.click(screen.getByRole("button", { name: "Show" }));
		expect(toggled).toBe(1);
		expect(sent).toEqual([["completed_tasks.toggled", { shown: true }]]);
	});
});
