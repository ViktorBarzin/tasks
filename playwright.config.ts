import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the BUILT server (`bun run build` first), outside
 * bun test's root. A real browser is the only check that catches a
 * server-only module leaking into the client bundle: build, tsc and curl all
 * pass, and hydration fails with "Buffer is not defined".
 *
 * Projects, one per input modality plus the service-worker suite:
 *  - mobile-chromium-touch: `*-touch` specs on a touchscreen descriptor;
 *    gestures are driven through CDP touch events (the real input pipeline);
 *  - desktop-chromium-mouse: `*-mouse`, smoke and access specs with the plain mouse
 *    (`hover: hover`, `pointer: fine`);
 *  - pwa: `sw/` specs with a LIVE service worker, served through the stub
 *    origin in e2e/fixtures/pwa-server.ts (page.route cannot stub requests a
 *    service worker makes). The cutover spec also serves the Svelte build
 *    from ../frontend/build (see e2e/global-setup.ts).
 * The gesture specs stub /api with page.route and block service workers for
 * determinism. Real iOS Safari checks go through `homelab ios`, not an
 * emulated viewport.
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
	retries: 0,
	reporter: "list",
	timeout: 30_000,
	globalSetup: "./e2e/global-setup.ts",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "mobile-chromium-touch",
			use: { ...devices["Pixel 7"], serviceWorkers: "block" },
			testMatch: /-touch\.spec\.ts$/,
		},
		{
			name: "desktop-chromium-mouse",
			use: { ...devices["Desktop Chrome"], serviceWorkers: "block" },
			testMatch: /(-mouse|smoke|access)\.spec\.ts$/,
		},
		{
			name: "pwa",
			// The installed-PWA shape: a home-screen app on a phone.
			use: { ...devices["Pixel 7"], serviceWorkers: "allow" },
			testMatch: /sw\/.*\.spec\.ts$/,
			timeout: 60_000,
		},
	],
	webServer: {
		command: "bun .output/server/index.mjs",
		url: `http://127.0.0.1:${port}/healthz`,
		reuseExistingServer: false,
		env: { HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test" },
	},
});
