import { useCallback, useSyncExternalStore } from "react";

import type { Readable } from "./store";

/** Subscribe a component to a store (src/client/store.ts). */
export function useStore<T>(store: Readable<T>): T {
	const subscribe = useCallback(
		(onChange: () => void) => store.subscribe(() => onChange()),
		[store],
	);
	const snapshot = useCallback(() => store.current(), [store]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
