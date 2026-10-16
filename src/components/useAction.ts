import { type RefCallback, useCallback, useLayoutEffect, useRef } from "react";

/**
 * A DOM action in the Svelte `use:` shape: `action(node, options)` returns
 * `{ update?, destroy? }`. The gesture engines in src/client/ui are written
 * that way (framework-free, imperative, rAF-driven); this attaches one to an
 * element through a callback ref, so it follows the element even when it
 * mounts later than the component.
 *
 * `update` runs after every render with the latest options, so callbacks the
 * action holds always close over the current render's state.
 */
export interface ActionHandle<O> {
	update?(options: O): void;
	destroy?(): void;
}

export type Action<O> = (
	node: HTMLElement,
	options: O,
) => ActionHandle<O> | undefined;

export function useAction<O>(
	action: Action<O>,
	options: O,
): RefCallback<HTMLElement> {
	const latest = useRef(options);
	const handle = useRef<ActionHandle<O> | null>(null);

	useLayoutEffect(() => {
		latest.current = options;
		handle.current?.update?.(options);
	});

	return useCallback(
		(node: HTMLElement | null) => {
			if (!node) return;
			const attached = action(node, latest.current) ?? {};
			handle.current = attached;
			return () => {
				attached.destroy?.();
				if (handle.current === attached) handle.current = null;
			};
		},
		[action],
	);
}
