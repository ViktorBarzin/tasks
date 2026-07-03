import { readable } from 'svelte/store';

/** A minute-tick clock so due chips / Today membership stay fresh while the
 * app sits open. Subscribed only while a screen uses it. */
export const now = readable(new Date(), (set) => {
	const tick = setInterval(() => set(new Date()), 60_000);
	return () => clearInterval(tick);
});
