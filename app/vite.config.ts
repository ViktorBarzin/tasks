import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Bun's built-ins exist only at runtime. Server code may import them; the
// client build has no such entry, so a leak into the browser fails the build.
const bunBuiltins = ["bun", /^bun:/];

/**
 * vite-plugin-pwa predates Vite's per-environment builds and would run once
 * per environment (client, ssr, nitro), rewriting the worker after Nitro has
 * recorded its size, which truncates it when served. Run it in the client
 * build only, which finishes before Nitro bakes its static-asset table.
 */
function clientOnly(plugins: PluginOption[]): Plugin[] {
	return (plugins as Plugin[]).map((plugin) => ({
		...plugin,
		applyToEnvironment: (environment) => environment.name === "client",
	}));
}

/**
 * The server bundles see AppGate's `import("virtual:pwa-register")` too, but
 * the PWA plugin runs in the client build only; give them an inert module.
 */
const pwaRegisterOnServer: Plugin = {
	name: "tasks:pwa-register-server-stub",
	applyToEnvironment: (environment) => environment.name !== "client",
	resolveId(id) {
		return id === "virtual:pwa-register" ? "\0pwa-register-stub" : undefined;
	},
	load(id) {
		return id === "\0pwa-register-stub"
			? "export function registerSW() { return async () => {}; }"
			: undefined;
	},
};

/** The precached app shell; must match SHELL_URL in src/client/sw/service-worker.ts. */
const SHELL_URL = "/";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	environments: {
		ssr: {
			// Every page is client-only: the UI renders from the IndexedDB
			// Replica, so the server answers every page with the same shell
			// (root route only), exactly what Start's SPA mode prerenders. One
			// precached copy of `/` then boots any route offline. TSS_SHELL is
			// the flag Start's SPA mode uses; setting it here avoids prerendering
			// at build time, which would need the server bundle to run under Node.
			define: { "process.env.TSS_SHELL": JSON.stringify("true") },
			build: { rolldownOptions: { external: bunBuiltins } },
		},
	},
	plugins: [
		devtools(),
		// Bun preset: `bun .output/server/index.mjs` (ADR-0001, Runtime).
		nitro({
			preset: "bun",
			// Boot steps: idle timeout, JSON console, /metrics port, LISTEN at
			// boot, graceful shutdown (src/server/lifecycle.server.ts).
			plugins: [
				fileURLToPath(
					new URL("./src/server/nitro-plugin.server.ts", import.meta.url),
				),
			],
			rollupConfig: {
				external: bunBuiltins,
				// Radix ships "use client" directives, which mean nothing to a server bundle.
				onwarn(warning, warn) {
					if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
				},
			},
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		// The PWA, same shape as the Svelte build's: a hand-written app-shell
		// worker (injectManifest) that swaps itself in on a new deploy
		// (skipWaiting + clientsClaim), registered from the app (AppGate).
		pwaRegisterOnServer,
		...clientOnly(
			VitePWA({
				registerType: "autoUpdate",
				strategies: "injectManifest",
				srcDir: "src/client/sw",
				// Nitro serves the client build from here; the worker must land in it
				// before Nitro bakes its static-asset table (it builds last).
				outDir: ".output/public",
				// Same URL as the Svelte build's worker, so installed PWAs update to it.
				filename: "service-worker.ts",
				injectRegister: null,
				includeAssets: ["favicon.png", "apple-touch-icon.png"],
				manifest: {
					name: "Tasks",
					short_name: "Tasks",
					description:
						"Reminders-style tasks for the household, backed by Nextcloud",
					start_url: "/",
					display: "standalone",
					background_color: "#111111",
					theme_color: "#111111",
					icons: [
						{ src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
						{ src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
						{
							src: "/pwa-512x512.png",
							sizes: "512x512",
							type: "image/png",
							purpose: "maskable",
						},
					],
				},
				injectManifest: {
					// The web manifest and its icons are added by the plugin itself.
					globPatterns: ["**/*.{js,css,svg,ico,webp,woff,woff2}"],
					// The shell is served by the server, not a file in the build, so
					// add it by hand. Its HTML references the hashed assets, so a
					// revision derived from them changes whenever the shell does.
					manifestTransforms: [
						async (entries) => {
							const hash = createHash("sha256");
							for (const e of [...entries].sort((a, b) =>
								a.url.localeCompare(b.url),
							))
								hash.update(`${e.url}@${e.revision ?? ""}\n`);
							return {
								manifest: [
									...entries,
									{
										url: SHELL_URL,
										revision: hash.digest("hex").slice(0, 16),
										size: 0,
									},
								],
							};
						},
					],
				},
				devOptions: { enabled: false },
			}),
		),
	],
});
