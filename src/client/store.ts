/**
 * A small stand-in for `svelte/store`, so the logic modules copied from the
 * Svelte build (replica, sync, actions, signin) keep their shape. Same
 * semantics as Svelte: `subscribe` calls back immediately with the current
 * value, `set` notifies only when the value changed (objects always count as
 * changed, like Svelte's `safe_not_equal`), and a `readable` with a start
 * function runs it on the first subscriber and stops on the last.
 *
 * React components read stores through `useStore` (src/client/useStore.ts).
 */

export type Subscriber<T> = (value: T) => void;
export type Unsubscriber = () => void;
export type Updater<T> = (value: T) => T;
type StartStop<T> = (set: (value: T) => void) => Unsubscriber | undefined;

export interface Readable<T> {
	subscribe(run: Subscriber<T>): Unsubscriber;
	/** The current value without subscribing (React's getSnapshot). */
	current(): T;
}

export interface Writable<T> extends Readable<T> {
	set(value: T): void;
	update(updater: Updater<T>): void;
}

function changed(a: unknown, b: unknown): boolean {
	if ((a !== null && typeof a === "object") || typeof a === "function")
		return true;
	return !Object.is(a, b);
}

export function writable<T>(initial: T, start?: StartStop<T>): Writable<T> {
	let value = initial;
	let stop: Unsubscriber | undefined;
	const subscribers = new Set<Subscriber<T>>();

	function set(next: T): void {
		if (!changed(value, next)) return;
		value = next;
		for (const run of [...subscribers]) run(value);
	}

	return {
		set,
		update(updater) {
			set(updater(value));
		},
		subscribe(run) {
			subscribers.add(run);
			if (subscribers.size === 1 && start) stop = start(set) ?? undefined;
			run(value);
			return () => {
				subscribers.delete(run);
				if (subscribers.size === 0 && stop) {
					stop();
					stop = undefined;
				}
			};
		},
		current() {
			return value;
		},
	};
}

export function readable<T>(initial: T, start?: StartStop<T>): Readable<T> {
	const { subscribe, current } = writable(initial, start);
	return { subscribe, current };
}

/** Read a store once (Svelte's `get`). */
export function get<T>(store: Readable<T>): T {
	let value: T | undefined;
	const unsubscribe = store.subscribe((v) => {
		value = v;
	});
	unsubscribe();
	return value as T;
}
