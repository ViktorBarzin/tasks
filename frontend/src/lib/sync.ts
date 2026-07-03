/**
 * The sync engine (ADR-0001). One cycle = drain the Op Queue via POST
 * /api/ops (ordered batches, per-op statuses), then — only when fully
 * drained — GET /api/sync with the stored cursor and fold the payload into
 * the Replica. Runs on launch/focus/online and after every local Op;
 * failures retry with exponential backoff. The server owns conflict
 * resolution (Silent LWW), so "duplicate" and "lww_reapplied" are successes.
 */
import { writable } from 'svelte/store';

import { api, ApiError } from './api';
import * as db from './db';
import { foldServerState } from './replica';

/** navigator.onLine + observed request outcomes. */
export const online = writable(true);
export const syncing = writable(false);
/** Op Queue depth — the pending-ops badge. */
export const pendingOps = writable(0);
/** Server said 401: the stored Nextcloud app password no longer works. */
export const needsReconnect = writable(false);
export const lastSyncAt = writable<number | null>(null);

const OPS_BATCH_SIZE = 25;
const MAX_OP_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

let inFlight: Promise<void> | null = null;
let runAgain = false;
let retryDelay = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export async function refreshPendingCount(): Promise<void> {
	pendingOps.set(await db.opCount());
}

export type DrainOutcome = 'drained' | 'blocked';

/**
 * Replay the Op Queue in order. Per-op outcomes:
 *  - applied / lww_reapplied / duplicate → done, remove from queue;
 *  - error → the server processed and rejected it; keep it for a bounded
 *    number of retries (a transient CalDAV hiccup), then drop it — the
 *    server copy wins, per Silent LWW.
 * A transport/HTTP failure throws and leaves the queue untouched.
 */
export async function drainOpQueue(): Promise<DrainOutcome> {
	for (;;) {
		const batch = await db.peekOps(OPS_BATCH_SIZE);
		if (batch.length === 0) return 'drained';

		const response = await api.ops(batch.map((q) => q.op));
		const byId = new Map(response.results.map((r) => [r.op_id, r]));
		const acked: number[] = [];
		let blocked = false;

		for (const q of batch) {
			const seq = q.seq as number;
			const result = byId.get(q.op.op_id);
			if (!result) {
				// The server never answered for this op — keep it, retry later.
				blocked = true;
				continue;
			}
			if (result.status === 'error') {
				if (q.attempts + 1 >= MAX_OP_ATTEMPTS) {
					console.warn(
						`tasks: dropping op ${q.op.op_id} (${q.op.kind}) after ${MAX_OP_ATTEMPTS} server rejections:`,
						result.error
					);
					acked.push(seq);
				} else {
					await db.bumpAttempts(seq);
					blocked = true;
				}
			} else {
				// applied | lww_reapplied | duplicate — all mean "the server has it".
				acked.push(seq);
			}
		}

		await db.removeOps(acked);
		await refreshPendingCount();
		if (blocked) return 'blocked';
	}
}

async function cycle(): Promise<void> {
	syncing.set(true);
	try {
		const outcome = await drainOpQueue();
		if (outcome === 'drained') {
			const payload = await api.sync(await db.getCursor());
			await foldServerState(payload);
			lastSyncAt.set(Date.now());
			resetBackoff();
		} else {
			// Reachable server but a stuck op — retry the whole cycle later.
			scheduleRetry();
		}
		online.set(true);
		needsReconnect.set(false);
	} catch (err) {
		if (err instanceof ApiError) {
			online.set(true);
			if (err.status === 401) {
				// Revoked/rotated app password: stop hammering; Onboarding resolves it.
				needsReconnect.set(true);
			} else {
				scheduleRetry();
			}
		} else {
			online.set(false);
			scheduleRetry();
		}
	} finally {
		syncing.set(false);
		await refreshPendingCount();
	}
}

/**
 * Run a sync cycle now. Coalesces: a call while one is in flight schedules
 * exactly one follow-up cycle (so a burst of local Ops syncs once more).
 */
export function syncNow(): Promise<void> {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		online.set(false);
		scheduleRetry();
		return Promise.resolve();
	}
	if (inFlight) {
		runAgain = true;
		return inFlight;
	}
	cancelRetryTimer();
	inFlight = (async () => {
		do {
			runAgain = false;
			await cycle();
		} while (runAgain);
	})().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

function scheduleRetry(): void {
	retryDelay = retryDelay === 0 ? BACKOFF_BASE_MS : Math.min(retryDelay * 2, BACKOFF_CAP_MS);
	cancelRetryTimer();
	retryTimer = setTimeout(() => {
		retryTimer = null;
		void syncNow();
	}, retryDelay);
}

function cancelRetryTimer(): void {
	if (retryTimer !== null) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

function resetBackoff(): void {
	retryDelay = 0;
	cancelRetryTimer();
}

/** Wire launch/focus/online triggers once, then kick the first cycle. */
export function startSync(): void {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('online', () => {
		online.set(true);
		resetBackoff();
		void syncNow();
	});
	window.addEventListener('offline', () => online.set(false));
	window.addEventListener('focus', () => void syncNow());
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void syncNow();
	});
	online.set(navigator.onLine !== false);
	void refreshPendingCount();
	void syncNow();
}

export function _resetSyncForTests(): void {
	inFlight = null;
	runAgain = false;
	retryDelay = 0;
	cancelRetryTimer();
	started = false;
	online.set(true);
	syncing.set(false);
	pendingOps.set(0);
	needsReconnect.set(false);
	lastSyncAt.set(null);
}
