/** Identity metrics, on the app's /metrics registry. */
import client from "prom-client";

import { registry } from "../metrics.server";

/**
 * Membership re-checks against Authentik: member, removed, unreachable (the
 * last answer stood), or misconfigured (no API URL or reader token; refused).
 */
export const membershipChecksTotal = new client.Counter({
	name: "tasks_membership_checks_total",
	help: "Membership re-checks against Authentik by outcome.",
	labelNames: ["outcome"] as const,
	registers: [registry],
});

/** Bearer-token verifications: ok, or why one was refused. */
export const tokenVerificationsTotal = new client.Counter({
	name: "tasks_api_token_verifications_total",
	help: "Bearer-token verifications by outcome.",
	labelNames: ["outcome"] as const,
	registers: [registry],
});

/** Requests refused by the CSRF origin check. */
export const csrfRejectionsTotal = new client.Counter({
	name: "tasks_csrf_rejections_total",
	help: "Requests refused by the CSRF origin check.",
	registers: [registry],
});

/** Sign-ins completed, by outcome: member, pending, or guest (sent back with prompt=login). */
export const signInsTotal = new client.Counter({
	name: "tasks_sign_ins_total",
	help: "OIDC sign-ins completed by outcome.",
	labelNames: ["outcome"] as const,
	registers: [registry],
});
