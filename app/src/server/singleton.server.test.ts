import { expect, test } from "bun:test";

import { processSingleton } from "./singleton.server";

test("the first value created for a key is the one every caller gets", () => {
	const key = `test-${crypto.randomUUID()}`;
	let made = 0;
	const a = processSingleton(key, () => ({ n: ++made }));
	const b = processSingleton(key, () => ({ n: ++made }));
	expect(b).toBe(a);
	expect(made).toBe(1);
	// The slot lives on globalThis, which a second bundled copy of the
	// module also sees.
	const slot = Symbol.for(`tasks:${key}`);
	expect((globalThis as unknown as Record<symbol, unknown>)[slot]).toBe(a);
});
