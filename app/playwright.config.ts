import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the BUILT server (`bun run build` first), outside
 * bun test's root. A real browser is the only check that catches a
 * server-only module leaking into the client bundle: build, tsc and curl all
 * pass, and hydration fails with "Buffer is not defined".
 *
 * The server binds 127.0.0.1 on a free port (E2E_PORT to pin one).
 */
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

// Workers inherit the env, so they see the port the main process chose.
process.env.E2E_PORT ??= String(await freePort());
const port = Number(process.env.E2E_PORT);

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	reporter: "list",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
	},
	// Real iOS Safari checks go through `homelab ios`, not an emulated viewport.
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "bun .output/server/index.mjs",
		url: `http://127.0.0.1:${port}/healthz`,
		reuseExistingServer: false,
		env: { HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test" },
	},
});
