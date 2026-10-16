/**
 * Test helpers for HTTP tests against the built server (`bun run build`
 * first): start `.output/server/index.mjs` on a free 127.0.0.1 port, a cookie
 * jar, a redirect follower, and a throwaway database.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SQL } from "bun";

export const APP_DIR = resolve(import.meta.dir, "../../../..");
export const SERVER_ENTRY = resolve(APP_DIR, ".output/server/index.mjs");
export const MIGRATIONS_DIR = resolve(APP_DIR, "drizzle");

export function builtServerExists(): boolean {
	return existsSync(SERVER_ENTRY);
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port as number;
	await probe.stop(true);
	return port;
}

export interface BuiltServer {
	origin: string;
	logs: string[];
	stop(): Promise<void>;
}

/** Env keys that must not leak from the developer's shell into the server under test. */
const SCRUBBED = [
	"DEV_USER",
	"PUBLIC_ORIGINS",
	"OIDC_DISCOVERY_URL",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
	"BETTER_AUTH_SECRET",
	"AUTHENTIK_API_URL",
	"AUTHENTIK_READER_TOKEN",
	"AUTHENTIK_APPROVER_TOKEN",
	"DATABASE_PASSWORD_FILE",
];

export async function startBuiltServer(
	env: Record<string, string>,
	options: { origin?: (port: number) => Record<string, string> } = {},
): Promise<BuiltServer> {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const base: Record<string, string | undefined> = { ...process.env };
	for (const key of SCRUBBED) delete base[key];
	const proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
		cwd: APP_DIR,
		env: {
			...base,
			NODE_ENV: "test",
			LOG_LEVEL: "INFO",
			HOST: "127.0.0.1",
			PORT: String(port),
			...(options.origin?.(port) ?? {}),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const logs: string[] = [];
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream)
			logs.push(...decoder.decode(chunk).split("\n").filter(Boolean));
	};
	void pump(proc.stdout);
	void pump(proc.stderr);
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			const res = await fetch(`${origin}/healthz`);
			if (res.ok) break;
		} catch {
			// not listening yet
		}
		if (proc.exitCode !== null || Date.now() > deadline) {
			throw new Error(`server did not start:\n${logs.join("\n")}`);
		}
		await Bun.sleep(100);
	}
	return {
		origin,
		logs,
		async stop() {
			proc.kill();
			// Graceful shutdown waits for open streams; do not wait long.
			const exited = await Promise.race([
				proc.exited.then(() => true),
				Bun.sleep(2_000).then(() => false),
			]);
			if (!exited) {
				proc.kill(9);
				await proc.exited;
			}
		},
	};
}

/** A minimal cookie jar for one origin. */
export class CookieJar {
	readonly cookies = new Map<string, string>();
	readonly raw: string[] = [];

	store(response: Response): void {
		for (const header of response.headers.getSetCookie()) {
			this.raw.push(header);
			const [pair, ...attributes] = header.split(";");
			const eq = (pair ?? "").indexOf("=");
			const name = (pair ?? "").slice(0, eq).trim();
			const value = (pair ?? "").slice(eq + 1).trim();
			const expired = attributes.some((a) => {
				const [k, v] = a.trim().split("=");
				if (k?.toLowerCase() === "max-age") return Number(v) <= 0;
				if (k?.toLowerCase() === "expires")
					return new Date(v ?? "").getTime() < Date.now();
				return false;
			});
			if (expired || value === "") this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	header(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}
}

export interface Hop {
	url: string;
	status: number;
	location: string | null;
}

/**
 * Follow redirects by hand like a browser would, keeping cookies for
 * `appOrigin`. Returns every hop and the final response.
 */
export async function follow(
	start: string,
	jar: CookieJar,
	appOrigin: string,
	maxHops = 12,
): Promise<{ hops: Hop[]; response: Response }> {
	const hops: Hop[] = [];
	let url = start;
	for (let i = 0; i < maxHops; i++) {
		const target = new URL(url);
		const headers: Record<string, string> = {};
		if (target.origin === appOrigin && jar.cookies.size > 0)
			headers.cookie = jar.header();
		const response = await fetch(url, { redirect: "manual", headers });
		if (target.origin === appOrigin) jar.store(response);
		const location = response.headers.get("location");
		hops.push({ url, status: response.status, location });
		if (response.status < 300 || response.status >= 400 || !location) {
			return { hops, response };
		}
		url = new URL(location, url).toString();
	}
	throw new Error(`too many redirects: ${hops.map((h) => h.url).join(" -> ")}`);
}

/** Creates databases on TEST_DATABASE_URL and drops them at the end. */
export class TestDatabases {
	private readonly created: string[] = [];
	constructor(private readonly adminUrl: string) {}

	async create(): Promise<string> {
		const name = `tasks_test_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new SQL(this.adminUrl);
		await admin.unsafe(`create database ${name}`);
		await admin.close();
		this.created.push(name);
		const url = new URL(this.adminUrl);
		url.pathname = `/${name}`;
		return url.toString();
	}

	async dropAll(): Promise<void> {
		const admin = new SQL(this.adminUrl);
		for (const name of this.created) {
			await admin.unsafe(`drop database if exists ${name} with (force)`);
		}
		await admin.close();
	}
}
