/**
 * One value per process, even when the module asking for it is bundled
 * twice. The built server has two module graphs: Nitro's entry (with the boot
 * plugin, src/server/nitro-plugin.server.ts) and Start's SSR bundle (routes,
 * server functions). A plain module-level `let` would give each its own pool,
 * LISTEN connection and metrics registry.
 */
export function processSingleton<T>(key: string, create: () => T): T {
	const store = globalThis as unknown as Record<symbol, unknown>;
	const slot = Symbol.for(`tasks:${key}`);
	if (!(slot in store)) store[slot] = create();
	return store[slot] as T;
}
