import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Where the cutover spec finds the old Svelte build (built here if missing). */
export const SVELTE_BUILD = join(
	import.meta.dirname,
	"..",
	"..",
	"frontend",
	"build",
);

/**
 * The cutover spec (e2e/sw/cutover.spec.ts) needs the Svelte PWA as it is
 * deployed today. Build it once from ../frontend when it is missing; set
 * E2E_SKIP_SVELTE_BUILD=1 to leave a missing build missing (the spec then
 * fails and says so).
 */
export default function globalSetup(): void {
	if (existsSync(join(SVELTE_BUILD, "index.html"))) return;
	if (process.env.E2E_SKIP_SVELTE_BUILD) return;
	const frontend = join(SVELTE_BUILD, "..");
	const run = (args: string[]) =>
		execFileSync("npm", args, { cwd: frontend, stdio: "inherit" });
	if (!existsSync(join(frontend, "node_modules")))
		run(["ci", "--no-audit", "--no-fund"]);
	run(["run", "build"]);
}
