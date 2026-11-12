/**
 * The app's server product events (tasks ADR-0005, infra ADR-0041), sent
 * through @viktorbarzin/telemetry/server. Nothing is sent before the Nitro
 * plugin starts the client, so tests and local runs without a write key send
 * nothing. `userId` is the caller's Authentik `sub`; the dev user has none,
 * and its events fall back to the request's visitor id.
 */
import { type TrackParams, track } from "@viktorbarzin/telemetry/server";

import type { WireOp } from "#/shared/contract";

export type Track = (message: TrackParams) => void;

function who(userId: string | null): { userId?: string } {
	return userId ? { userId } : {};
}

/**
 * The event for an op that took effect (applied or LWW re-applied), or null
 * for kinds that are not a core action. Properties hold no task content.
 */
export function opAppliedEvent(
	op: WireOp,
	userId: string | null,
): TrackParams | null {
	switch (op.kind) {
		case "task_create":
			return {
				event: "task.created",
				...who(userId),
				properties: {
					has_due_date: typeof op.due === "string" && op.due !== "",
					priority: typeof op.priority === "number" ? op.priority : 0,
				},
			};
		case "task_complete":
			return { event: "task.completed", ...who(userId), properties: {} };
		case "list_create":
			return { event: "list.created", ...who(userId), properties: {} };
		default:
			return null;
	}
}

/** A Connected Account was saved after a live CalDAV check (POST /api/onboard). */
export function accountConnected(userId: string | null, send: Track = track) {
	send({ event: "account.connected", ...who(userId), properties: {} });
}
