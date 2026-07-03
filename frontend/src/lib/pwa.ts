/**
 * Keep an installed PWA off a stale bundle. An autoUpdate service worker only
 * checks for a new build when the browser re-fetches it; an installed,
 * long-lived standalone app may go days without that, pinning an old deploy.
 * So we poll `registration.update()` hourly while open AND whenever the app
 * returns to the foreground (tripit's ReloadPrompt pattern, contract-delta §K).
 */

/** Hourly — matches tripit's cadence. */
export const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** The slice of ServiceWorkerRegistration we drive (keeps this unit testable). */
export interface SwUpdatable {
	update(): Promise<unknown> | unknown;
}

/** The slice of `document` we observe — narrow so tests can pass a fake. */
export interface VisibilityDoc {
	visibilityState: DocumentVisibilityState;
	addEventListener(type: 'visibilitychange', listener: () => void): void;
	removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Schedule update checks for a registered service worker. Returns a teardown
 * that clears the timer and detaches the listener.
 */
export function scheduleSwUpdates(registration: SwUpdatable, doc: VisibilityDoc = document): () => void {
	const check = (): void => void registration.update();
	const timer = setInterval(check, SW_UPDATE_INTERVAL_MS);
	const onVisible = (): void => {
		if (doc.visibilityState === 'visible') check();
	};
	doc.addEventListener('visibilitychange', onVisible);
	return () => {
		clearInterval(timer);
		doc.removeEventListener('visibilitychange', onVisible);
	};
}
