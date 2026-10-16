import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// Bun's built-ins exist only at runtime. Server code may import them; the
// client build has no such entry, so a leak into the browser fails the build.
const bunBuiltins = ["bun", /^bun:/];

export default defineConfig({
	resolve: { tsconfigPaths: true },
	environments: {
		ssr: { build: { rolldownOptions: { external: bunBuiltins } } },
	},
	plugins: [
		devtools(),
		// Bun preset: `bun .output/server/index.mjs` (ADR-0001, Runtime).
		nitro({
			preset: "bun",
			rollupConfig: {
				external: bunBuiltins,
				// Radix ships "use client" directives, which mean nothing to a server bundle.
				onwarn(
					warning: { code?: string },
					warn: (w: { code?: string }) => void,
				) {
					if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
				},
			},
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});
